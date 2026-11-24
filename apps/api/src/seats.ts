// Windows games run in "seat" containers (Wine + a virtual screen, see docker/seat). This module
// hands seats out to players, starts and stops their game through each seat's agent, copies save
// files between the seat and the player's save slot, and relays the game's screen (a VNC stream over
// WebSocket) and sound to the browser of the player who owns the seat, and nobody else.
import crypto from "node:crypto";
import net from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "./config.ts";
import { requireApproved, userFromCookieHeader } from "./auth.ts";
import { getGame, isPlayable, type Game } from "./games.ts";
import { readSave, storeSave } from "./saves.ts";

const AGENT_PORT = 7000;
/** Seat WebSocket endpoints relayed for the seat's owner: the screen (VNC) and the sound stream. */
const STREAMS: Record<string, number> = { "/api/seat/ws": 6080, "/api/seat/audio": 6081 };
const SYNC_EVERY_MS = 60_000;
/** A seat whose player has no open stream is freed after this long (closed tab, lost connection). */
const DISCONNECTED_GRACE_MS = 5 * 60_000;

type Session = {
  seat: string;
  userId: number;
  gameId: string;
  slot: number;
  startedAt: number;
  /** Last mouse/keyboard input from the player (reported by the seat page's pings). */
  lastInput: number;
  /** When the last stream closed (null while one is open). */
  disconnectedAt: number | null;
  streams: Set<Duplex>;
  lastSaveHash: string | null;
  busy: Promise<unknown> | null;
};

/** seat name → session (seats not in the map are free). */
const sessions = new Map<string, Session>();

const log = { info: (_m: string) => {}, warn: (_m: string) => {} };

async function agent(seat: string, method: "GET" | "POST", path: string, opts: { body?: Buffer; headers?: Record<string, string> } = {}) {
  const res = await fetch(`http://${seat}:${AGENT_PORT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.seatToken}`, ...opts.headers },
    body: opts.body ? new Uint8Array(opts.body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok && res.status !== 204) {
    const msg = await res.text().catch(() => "");
    throw new Error(`seat ${seat} ${path}: HTTP ${res.status} ${msg.slice(0, 200)}`);
  }
  return res;
}

function sessionOf(userId: number): Session | undefined {
  for (const s of sessions.values()) if (s.userId === userId) return s;
  return undefined;
}

/** Run one operation at a time per session (start/save/stop must not overlap). */
async function serial<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  while (s.busy) await s.busy.catch(() => {});
  const p = fn();
  s.busy = p;
  try {
    return await p;
  } finally {
    s.busy = null;
  }
}

/** Copy the seat's changed files into the player's save slot. */
async function saveNow(s: Session): Promise<"saved" | "nochange"> {
  const res = await agent(s.seat, "GET", "/save");
  if (res.status === 204) return "nochange";
  const zip = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash("sha256").update(zip).digest("hex");
  if (hash === s.lastSaveHash) return "nochange";
  storeSave(s.userId, s.gameId, s.slot, zip, null);
  s.lastSaveHash = hash;
  return "saved";
}

/** Final save, stop the game, free the seat. */
async function endSession(s: Session, why: string) {
  await serial(s, async () => {
    try {
      await saveNow(s);
    } catch (e) {
      log.warn(`final save failed for user ${s.userId} on ${s.seat}: ${(e as Error).message}`);
    }
    await agent(s.seat, "POST", "/stop").catch(() => {});
  });
  for (const st of s.streams) st.destroy();
  sessions.delete(s.seat);
  log.info(`seat ${s.seat} freed (${why})`);
}

async function startSession(userId: number, game: Game, slot: number): Promise<Session> {
  const existing = sessionOf(userId);
  if (existing) {
    if (existing.gameId === game.id && existing.slot === slot) return existing; // reconnect
    await endSession(existing, "player started another game");
  }
  const seat = config.seats.find((name) => !sessions.has(name));
  if (!seat) throw Object.assign(new Error("All game seats are busy right now. Please try again in a few minutes."), { statusCode: 503 });

  const now = Date.now();
  const s: Session = {
    seat,
    userId,
    gameId: game.id,
    slot,
    startedAt: now,
    lastInput: now,
    disconnectedAt: now,
    streams: new Set(),
    lastSaveHash: null,
    busy: null,
  };
  sessions.set(seat, s); // reserve before the slow start so no one else gets it
  try {
    const save = readSave(userId, game.id, slot);
    if (save) s.lastSaveHash = crypto.createHash("sha256").update(save).digest("hex");
    const cfg = { folder: game.folder, ...game.seat };
    await serial(s, () =>
      agent(seat, "POST", "/start", {
        body: save ?? Buffer.alloc(0),
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Seat-Game": Buffer.from(JSON.stringify(cfg)).toString("base64"),
        },
      }),
    );
    log.info(`seat ${seat} → user ${userId}, ${game.id} slot ${slot}`);
    return s;
  } catch (e) {
    sessions.delete(seat);
    throw e;
  }
}

function parseGameSlot(params: { gameId: string; slot: string }, reply: FastifyReply): { game: Game; slot: number } | null {
  const game = getGame(params.gameId);
  if (!game || game.emulator !== "wine" || !isPlayable(game)) {
    reply.code(404).send({ error: "Game not found" });
    return null;
  }
  const slot = Number(params.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > config.maxSlots) {
    reply.code(400).send({ error: `Slot must be between 1 and ${config.maxSlots}` });
    return null;
  }
  return { game, slot };
}

export async function seatRoutes(app: FastifyInstance) {
  log.info = (m) => app.log.info(m);
  log.warn = (m) => app.log.warn(m);

  app.post<{ Params: { gameId: string; slot: string } }>(
    "/api/seat/:gameId/:slot/start",
    { preHandler: requireApproved },
    async (req, reply) => {
      const p = parseGameSlot(req.params, reply);
      if (!p) return;
      try {
        await startSession(req.user!.id, p.game, p.slot);
        return { ok: true };
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode ?? 500;
        if (code === 500) req.log.error(e);
        return reply.code(code).send({ error: code === 503 ? (e as Error).message : "The game couldn't be started" });
      }
    },
  );

  app.get("/api/seat/status", { preHandler: requireApproved }, async (req) => {
    const s = sessionOf(req.user!.id);
    if (!s) return { active: false };
    const status = (await (await agent(s.seat, "GET", "/status")).json()) as { running: boolean };
    return { active: true, gameId: s.gameId, slot: s.slot, running: status.running };
  });

  app.post("/api/seat/sync", { preHandler: requireApproved }, async (req, reply) => {
    const s = sessionOf(req.user!.id);
    if (!s) return reply.code(409).send({ error: "No game running" });
    try {
      return { result: await serial(s, () => saveNow(s)) };
    } catch (e) {
      req.log.error(e);
      return reply.code(502).send({ error: "Cloud save failed" });
    }
  });

  // The seat page pings while the player is using the mouse or keyboard (the VNC stream itself
  // carries the viewer's own update requests, so traffic alone doesn't mean someone is playing).
  app.post("/api/seat/ping", { preHandler: requireApproved }, async (req) => {
    const s = sessionOf(req.user!.id);
    if (s) s.lastInput = Date.now();
    return { active: !!s };
  });

  app.post("/api/seat/stop", { preHandler: requireApproved }, async (req) => {
    const s = sessionOf(req.user!.id);
    if (s) await endSession(s, "player exited");
    return { ok: true };
  });

  // Housekeeping: regular saves, and freeing seats that are closed, abandoned or idle.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.busy) continue;
      void (async () => {
        try {
          const { running } = (await (await agent(s.seat, "GET", "/status")).json()) as { running: boolean };
          if (!running) return endSession(s, "game closed");
          if (s.disconnectedAt && now - s.disconnectedAt > DISCONNECTED_GRACE_MS) return endSession(s, "player left");
          if (now - s.lastInput > config.seatIdleMinutes * 60_000) return endSession(s, "idle");
          await serial(s, () => saveNow(s));
        } catch (e) {
          log.warn(`seat ${s.seat} housekeeping: ${(e as Error).message}`);
        }
      })();
    }
  }, SYNC_EVERY_MS);
  timer.unref();

  // Save everyone's progress when the app is stopped (e.g. during an update).
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await Promise.allSettled([...sessions.values()].map((s) => endSession(s, "server stopping")));
  });

  // The game's screen and sound: WebSocket upgrades on /api/seat/ws and /api/seat/audio, relayed
  // byte-for-byte to the owner's seat.
  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const port = STREAMS[(req.url ?? "").split("?")[0]];
    if (!port) return; // not ours
    const user = userFromCookieHeader(req.headers.cookie);
    const s = user && user.status === "approved" ? sessionOf(user.id) : undefined;
    if (!s) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, s.seat);
    upstream.on("connect", () => {
      // Replay the browser's upgrade request to websockify, then pipe both ways.
      const lines = [`GET / HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (/^(cookie|host)$/i.test(k)) continue; // the seat doesn't need the player's session cookie
        lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`Host: ${s.seat}:${port}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) upstream.write(head);
      s.streams.add(socket);
      s.disconnectedAt = null;
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
      if (s.streams.delete(socket) && s.streams.size === 0) s.disconnectedAt = Date.now();
    };
    upstream.on("error", close);
    upstream.on("close", close);
    socket.on("error", close);
    socket.on("close", close);
  });
}

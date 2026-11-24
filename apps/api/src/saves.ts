import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { requireApproved } from "./auth.ts";
import { getGame, isPlayable } from "./games.ts";

type SaveRow = {
  id: number;
  user_id: number;
  game_id: string;
  slot: number;
  label: string;
  size: number;
  created_at: number;
  updated_at: number;
};

type Params = { gameId: string; slot: string };

export function savePath(userId: number, gameId: string, slot: number) {
  return path.join(config.dataDir, "saves", String(userId), gameId, `${slot}.zip`);
}

function parse(params: Params, reply: FastifyReply): { gameId: string; slot: number } | null {
  const game = getGame(params.gameId);
  if (!game || !isPlayable(game)) {
    reply.code(404).send({ error: "Game not found" });
    return null;
  }
  const slot = Number(params.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > config.maxSlots) {
    reply.code(400).send({ error: `Slot must be between 1 and ${config.maxSlots}` });
    return null;
  }
  return { gameId: game.id, slot };
}

function toApi(r: SaveRow) {
  return { slot: r.slot, label: r.label, size: r.size, createdAt: r.created_at, updatedAt: r.updated_at };
}

/** Read a slot's save archive, or null if the slot is empty. */
export function readSave(userId: number, gameId: string, slot: number): Buffer | null {
  const file = savePath(userId, gameId, slot);
  if (!getRowStmt().get(userId, gameId, slot) || !fs.existsSync(file)) return null;
  return fs.readFileSync(file);
}

/** Write a slot's save archive atomically and record it. `label` null keeps the existing label. */
export function storeSave(userId: number, gameId: string, slot: number, body: Buffer, label: string | null) {
  const file = savePath(userId, gameId, slot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  const now = Date.now();
  db.prepare(
    `INSERT INTO saves (user_id, game_id, slot, label, size, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, game_id, slot) DO UPDATE SET
       size = excluded.size,
       updated_at = excluded.updated_at,
       label = CASE WHEN ? IS NULL THEN saves.label ELSE excluded.label END`,
  ).run(userId, gameId, slot, label ?? "", body.length, now, now, label);
}

let getRowCached: ReturnType<typeof db.prepare> | null = null;
function getRowStmt() {
  getRowCached ??= db.prepare(`SELECT * FROM saves WHERE user_id = ? AND game_id = ? AND slot = ?`);
  return getRowCached;
}

export async function saveRoutes(app: FastifyInstance) {
  // Save archives are raw zip bytes from js-dos' ci.persist().
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: config.maxSaveBytes },
    (_req, body, done) => done(null, body),
  );

  const getRow = db.prepare(`SELECT * FROM saves WHERE user_id = ? AND game_id = ? AND slot = ?`);

  app.get<{ Params: { gameId: string } }>("/api/saves/:gameId", { preHandler: requireApproved }, async (req) => {
    const rows = db
      .prepare(`SELECT * FROM saves WHERE user_id = ? AND game_id = ? ORDER BY slot`)
      .all(req.user!.id, req.params.gameId) as SaveRow[];
    return { saves: rows.map(toApi), maxSlots: config.maxSlots };
  });

  app.get<{ Params: Params }>("/api/saves/:gameId/:slot", { preHandler: requireApproved }, async (req, reply) => {
    const p = parse(req.params, reply);
    if (!p) return;
    const file = savePath(req.user!.id, p.gameId, p.slot);
    if (!getRow.get(req.user!.id, p.gameId, p.slot) || !fs.existsSync(file))
      return reply.code(404).send({ error: "No save in this slot" });
    reply.header("Content-Type", "application/octet-stream").header("Cache-Control", "no-store");
    return reply.send(fs.createReadStream(file));
  });

  app.put<{ Params: Params; Body: Buffer; Querystring: { label?: string } }>(
    "/api/saves/:gameId/:slot",
    { preHandler: requireApproved },
    async (req, reply) => {
      const p = parse(req.params, reply);
      if (!p) return;
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 4 || body[0] !== 0x50 || body[1] !== 0x4b)
        return reply.code(400).send({ error: "Save data must be a zip archive" });

      const label = typeof req.query.label === "string" ? req.query.label.slice(0, 60) : null;
      storeSave(req.user!.id, p.gameId, p.slot, body, label);
      return { save: toApi(getRow.get(req.user!.id, p.gameId, p.slot) as SaveRow) };
    },
  );

  app.patch<{ Params: Params; Body: { label?: string } }>(
    "/api/saves/:gameId/:slot",
    { preHandler: requireApproved },
    async (req, reply) => {
      const p = parse(req.params, reply);
      if (!p) return;
      const label = String(req.body?.label ?? "").slice(0, 60);
      const res = db
        .prepare(`UPDATE saves SET label = ? WHERE user_id = ? AND game_id = ? AND slot = ?`)
        .run(label, req.user!.id, p.gameId, p.slot);
      if (res.changes === 0) return reply.code(404).send({ error: "No save in this slot" });
      return { ok: true };
    },
  );

  app.delete<{ Params: Params }>("/api/saves/:gameId/:slot", { preHandler: requireApproved }, async (req, reply) => {
    const p = parse(req.params, reply);
    if (!p) return;
    db.prepare(`DELETE FROM saves WHERE user_id = ? AND game_id = ? AND slot = ?`).run(req.user!.id, p.gameId, p.slot);
    fs.rmSync(savePath(req.user!.id, p.gameId, p.slot), { force: true });
    return { ok: true };
  });
}

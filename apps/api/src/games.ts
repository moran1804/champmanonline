import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { once } from "node:events";
import { Zip, ZipDeflate } from "fflate";
import { config } from "./config.ts";
import { requireApproved } from "./auth.ts";
import { findLookupFile, readLookup } from "./lookup.ts";

export type Game = {
  id: string;
  title: string;
  year: number;
  platform: "dos" | "windows";
  emulator: "jsdos" | "tbd";
  enabled: boolean;
  /** Sub-folder of GAMES_ROOT; the game itself is in "<folder>/<gameSubdir>". */
  folder: string;
  /** Folder inside `folder` holding the game files. Default "Game Files"; "." for the folder itself. */
  gameSubdir?: string;
  /** Folder (under GAMES_ROOT) to take the cover image from, if not `folder`. */
  coverFolder?: string;
  exclude?: string[];
  dosbox?: { cycles?: string; memsize?: number; autoexec: string[] };
  /**
   * Files to add to (or replace in) the bundle, keyed by path inside the game folder, with text
   * content. Matching is case-insensitive, as in DOS. Used for fixing install-specific config files.
   */
  files?: Record<string, string>;
  /** How taps move the DOS mouse on touch screens; "relative" for games that only read mouse movement. */
  touchMouse?: "absolute" | "relative";
  /** Shown on the game's page, e.g. edition quirks or how to answer its copy check. */
  note?: string;
  /** Text/RTF/CSV file (relative to the version folder) with the manual-lookup answers. */
  lookupFile?: string;
};

export function loadCatalog(): Game[] {
  return JSON.parse(fs.readFileSync(config.catalogPath, "utf8")) as Game[];
}

export function getGame(id: string): Game | undefined {
  return loadCatalog().find((g) => g.id === id);
}

function gameDir(game: Game) {
  return path.join(config.gamesRoot, game.folder, game.gameSubdir ?? "Game Files");
}

function findCover(game: Game): string | null {
  const dir = path.join(config.gamesRoot, game.coverFolder ?? game.folder);
  try {
    const f = fs.readdirSync(dir).find((n) => /_cover_.*\.(webp|jpe?g|png)$/i.test(n));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

/** A manual PDF in the version folder, e.g. "Game Files/<folder>/manual.pdf" (any name containing "manual"). */
function findManual(game: Game): string | null {
  const dir = path.join(config.gamesRoot, game.folder);
  try {
    const f = fs.readdirSync(dir).find((n) => /manual.*\.pdf$/i.test(n) && !n.startsWith("._"));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

function lookupFileFor(game: Game): string | null {
  const versionDir = path.join(config.gamesRoot, game.folder);
  if (game.lookupFile) {
    const f = path.join(versionDir, game.lookupFile);
    return fs.existsSync(f) ? f : null;
  }
  return findLookupFile(versionDir);
}

export function isPlayable(game: Game): boolean {
  return game.enabled && game.emulator === "jsdos" && !!game.dosbox && fs.existsSync(gameDir(game));
}

export function dosboxConf(game: Game): string {
  const d = game.dosbox!;
  return [
    "[sdl]",
    "autolock=false",
    "",
    "[dosbox]",
    "machine=svga_s3",
    `memsize=${d.memsize ?? 16}`,
    "",
    "[cpu]",
    "core=auto",
    "cputype=auto",
    `cycles=${d.cycles ?? "max"}`,
    "",
    "[mixer]",
    "rate=44100",
    "",
    "[sblaster]",
    "sbtype=sb16",
    "oplmode=auto",
    "",
    "[autoexec]",
    "echo off",
    ...d.autoexec,
    "",
  ].join("\n");
}

function listFiles(root: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (ent.name === ".DS_Store" || ent.name.startsWith("._")) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (exclude.has(r.toLowerCase())) continue;
      if (ent.isDirectory()) walk(r);
      else if (ent.isFile()) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

const building = new Map<string, Promise<{ file: string; version: string }>>();

/**
 * Builds (or reuses from cache) the .jsdos bundle for a game: a zip of the game folder plus
 * .jsdos/dosbox.conf. The cache key covers the file list, sizes, mtimes and config, so
 * changing any source file or catalog setting produces a fresh bundle with a new version.
 * The zip is streamed to disk, so large games (e.g. a 650 MB CD image) don't need to fit in memory.
 */
export async function ensureBundle(game: Game): Promise<{ file: string; version: string }> {
  const src = gameDir(game);
  const exclude = new Set((game.exclude ?? []).map((e) => e.toLowerCase()));
  const files = listFiles(src, exclude);
  const conf = dosboxConf(game);

  // Overrides replace same-named files regardless of case (DOS is case-insensitive, the emulator's FS isn't).
  const overrides = new Map<string, { name: string; data: Uint8Array }>();
  for (const [name, text] of Object.entries(game.files ?? {})) {
    overrides.set(name.toLowerCase(), { name, data: new TextEncoder().encode(text) });
  }

  const h = crypto.createHash("sha256").update(conf).update(JSON.stringify(game.files ?? {}));
  const sizes = new Map<string, number>();
  for (const f of files) {
    const st = fs.statSync(path.join(src, f));
    sizes.set(f, st.size);
    h.update(`${f}\0${st.size}\0${st.mtimeMs}\n`);
  }
  const version = h.digest("hex").slice(0, 16);

  const cacheDir = path.join(config.dataDir, "cache", "bundles");
  const file = path.join(cacheDir, `${game.id}-${version}.jsdos`);
  if (fs.existsSync(file)) return { file, version };

  const pending = building.get(file);
  if (pending) return pending;

  const job = (async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const out = fs.createWriteStream(tmp);
    const done = new Promise<void>((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
    });
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        out.destroy(err);
        return;
      }
      out.write(chunk);
      if (final) out.end();
    });
    const drain = async () => {
      if (out.writableNeedDrain) await once(out, "drain");
    };
    const addBytes = (name: string, data: Uint8Array) => {
      const entry = new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      entry.push(data, true);
    };

    addBytes(".jsdos/dosbox.conf", new TextEncoder().encode(conf));
    for (const f of files) {
      const o = overrides.get(f.toLowerCase());
      if (o) {
        overrides.delete(f.toLowerCase());
        addBytes(f, o.data);
        continue;
      }
      // Big files (CD images, videos) get fast compression; the rest is compressed harder.
      const entry = new ZipDeflate(f, { level: (sizes.get(f) ?? 0) > 20_000_000 ? 1 : 6 });
      zip.add(entry);
      for await (const chunk of fs.createReadStream(path.join(src, f), { highWaterMark: 4 * 1024 * 1024 })) {
        entry.push(new Uint8Array(chunk as Buffer));
        await drain();
      }
      entry.push(new Uint8Array(0), true);
      await drain();
    }
    for (const o of overrides.values()) addBytes(o.name, o.data);
    zip.end();
    await done;
    fs.renameSync(tmp, file);

    // Remove stale builds of this game.
    for (const old of fs.readdirSync(cacheDir)) {
      if (old.startsWith(`${game.id}-`) && old !== path.basename(file)) fs.rmSync(path.join(cacheDir, old), { force: true });
    }
    return { file, version };
  })();

  building.set(file, job);
  try {
    return await job;
  } finally {
    building.delete(file);
  }
}

export async function gameRoutes(app: FastifyInstance) {
  app.get("/api/games", { preHandler: requireApproved }, async () => {
    return {
      games: loadCatalog().map((g) => ({
        id: g.id,
        title: g.title,
        year: g.year,
        platform: g.platform,
        playable: isPlayable(g),
        hasCover: findCover(g) !== null,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/games/:id", { preHandler: requireApproved }, async (req, reply) => {
    const game = getGame(req.params.id);
    if (!game || !isPlayable(game)) return reply.code(404).send({ error: "Game not found" });
    const { version } = await ensureBundle(game);
    return {
      game: {
        id: game.id,
        title: game.title,
        year: game.year,
        platform: game.platform,
        emulator: game.emulator,
        bundleUrl: `/api/games/${game.id}/bundle?v=${version}`,
        dosboxConf: dosboxConf(game),
        hasManual: findManual(game) !== null,
        hasLookup: lookupFileFor(game) !== null,
        note: game.note ?? null,
        touchMouse: game.touchMouse ?? "absolute",
        maxSlots: config.maxSlots,
      },
    };
  });

  app.get<{ Params: { id: string } }>("/api/games/:id/bundle", { preHandler: requireApproved }, async (req, reply) => {
    const game = getGame(req.params.id);
    if (!game || !isPlayable(game)) return reply.code(404).send({ error: "Game not found" });
    const { file, version } = await ensureBundle(game);
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Length", String(fs.statSync(file).size))
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("ETag", `"${version}"`);
    return reply.send(fs.createReadStream(file));
  });

  // The game manual (needed to answer the game's own manual-lookup check), for approved players only.
  app.get<{ Params: { id: string } }>("/api/games/:id/manual", { preHandler: requireApproved }, async (req, reply) => {
    const game = getGame(req.params.id);
    const manual = game ? findManual(game) : null;
    if (!manual) return reply.code(404).send({ error: "No manual for this game yet" });
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="${game!.id}-manual.pdf"`)
      .header("Cache-Control", "private, max-age=3600");
    return reply.send(fs.createReadStream(manual));
  });

  // The manual's answer table (e.g. CM 93/94's page → match results check), for approved players only.
  app.get<{ Params: { id: string } }>("/api/games/:id/lookup", { preHandler: requireApproved }, async (req, reply) => {
    const game = getGame(req.params.id);
    const file = game ? lookupFileFor(game) : null;
    if (!file) return reply.code(404).send({ error: "No results table for this game yet" });
    reply.header("Cache-Control", "private, no-cache");
    return { title: game!.title, ...readLookup(file) };
  });

  // Covers are shown on the public landing page, so they don't need a session.
  app.get<{ Params: { id: string } }>("/api/games/:id/cover", async (req, reply) => {
    const game = getGame(req.params.id);
    const cover = game ? findCover(game) : null;
    if (!cover) return reply.code(404).send({ error: "No cover" });
    const ext = path.extname(cover).slice(1).toLowerCase();
    reply
      .header("Content-Type", ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "image/jpeg")
      .header("Cache-Control", "public, max-age=86400");
    return reply.send(fs.createReadStream(cover));
  });
}

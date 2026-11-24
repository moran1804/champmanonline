import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { once } from "node:events";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { Zip, type ZipInputFile } from "fflate";
import { config } from "./config.ts";
import { requireApproved } from "./auth.ts";
import { findLookupFile, readLookup } from "./lookup.ts";

export type Game = {
  id: string;
  title: string;
  year: number;
  platform: "dos" | "windows";
  /** Homepage group, e.g. "championship-manager", "point-and-click", "adult". */
  category: string;
  emulator: "jsdos" | "wine" | "tbd";
  enabled: boolean;
  /** Sub-folder of GAMES_ROOT; the game itself is in "<folder>/<gameSubdir>". */
  folder: string;
  /** Folder inside `folder` holding the game files. Default "Game Files"; "." for the folder itself. */
  gameSubdir?: string;
  /** Folder (under GAMES_ROOT) to take the cover image from, if not `folder`. */
  coverFolder?: string;
  exclude?: string[];
  dosbox?: {
    cycles?: string;
    memsize?: number;
    cputype?: string;
    core?: string;
    /** Extra dosbox.conf lines (with their [section] headers), e.g. ["[sblaster]", "sbtype=none"]. */
    extra?: string[];
    autoexec: string[];
  };
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
  /** Why this game can't be offered (shown on its tile instead of "Coming soon"). */
  unavailable?: string;
  /** Manual PDF (relative to the version folder), if it isn't a "*manual*.pdf" directly in it. */
  manualFile?: string;
  /** Windows games: how a seat runs it. Paths are relative to the version folder. */
  seat?: SeatGame;
};

export type SeatGame = {
  /** Ready-installed copy of the game (copied fresh for every session). */
  installDir: string;
  /** Where the installer put it, e.g. "C:\\Program Files (x86)\\Championship Manager 01-02". */
  windowsPath: string;
  /** Executable inside the install folder. */
  exe: string;
  args?: string[];
  /** Unpacked CD, mounted as D: (with a .windows-label file for the volume name). */
  discDir?: string;
  /** .reg file with the installer's registry keys. */
  registry?: string;
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
    const f = fs.readdirSync(dir).find((n) => /(_cover_.*|^cover)\.(webp|jpe?g|png|gif)$/i.test(n));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

/** A manual PDF in the version folder, e.g. "Game Files/<folder>/manual.pdf" (any name containing "manual"). */
function findManual(game: Game): string | null {
  const dir = path.join(config.gamesRoot, game.folder);
  if (game.manualFile) {
    const f = path.join(dir, game.manualFile);
    return f.startsWith(dir + path.sep) && fs.existsSync(f) ? f : null;
  }
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
  if (!game.enabled) return false;
  if (game.emulator === "jsdos") return !!game.dosbox && fs.existsSync(gameDir(game));
  if (game.emulator === "wine")
    return config.seats.length > 0 && !!game.seat && fs.existsSync(path.join(config.gamesRoot, game.folder, game.seat.installDir));
  return false;
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
    `core=${d.core ?? "auto"}`,
    `cputype=${d.cputype ?? "auto"}`,
    `cycles=${d.cycles ?? "max"}`,
    "",
    "[mixer]",
    "rate=44100",
    "",
    "[sblaster]",
    "sbtype=sb16",
    "oplmode=auto",
    "",
    ...(d.extra?.length ? [...d.extra, ""] : []),
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
    // Compression is done by Node's zlib, not fflate's ZipDeflate: fflate 0.8.3's streaming deflate
    // produced corrupt data for some files (e.g. Colonization's VICEROY.PAL), which js-dos rejects.
    const addEntry = async (name: string, input: Readable, level: number) => {
      const entry = { filename: name, size: 0, crc: 0, compression: 8 } as ZipInputFile;
      zip.add(entry);
      let crc = 0;
      let size = 0;
      input.on("data", (c: Buffer) => {
        crc = zlib.crc32(c, crc);
        size += c.length;
      });
      const deflate = input.pipe(zlib.createDeflateRaw({ level }));
      for await (const chunk of deflate) {
        entry.ondata!(null, new Uint8Array(chunk as Buffer), false);
        await drain();
      }
      entry.crc = crc;
      entry.size = size;
      entry.ondata!(null, new Uint8Array(0), true);
      await drain();
    };
    const addBytes = (name: string, data: Uint8Array) => addEntry(name, Readable.from([Buffer.from(data)]), 6);

    await addBytes(".jsdos/dosbox.conf", new TextEncoder().encode(conf));
    for (const f of files) {
      const o = overrides.get(f.toLowerCase());
      if (o) {
        overrides.delete(f.toLowerCase());
        await addBytes(f, o.data);
        continue;
      }
      // Big files (CD images, videos) get fast compression; the rest is compressed harder.
      const level = (sizes.get(f) ?? 0) > 20_000_000 ? 1 : 6;
      await addEntry(f, fs.createReadStream(path.join(src, f), { highWaterMark: 4 * 1024 * 1024 }), level);
    }
    for (const o of overrides.values()) await addBytes(o.name, o.data);
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
        category: g.category,
        playable: isPlayable(g),
        unavailable: g.unavailable ?? null,
        hasCover: findCover(g) !== null,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/games/:id", { preHandler: requireApproved }, async (req, reply) => {
    const game = getGame(req.params.id);
    if (!game || !isPlayable(game)) return reply.code(404).send({ error: "Game not found" });
    const dos = game.emulator === "jsdos";
    const version = dos ? (await ensureBundle(game)).version : null;
    return {
      game: {
        id: game.id,
        title: game.title,
        year: game.year,
        platform: game.platform,
        emulator: game.emulator,
        bundleUrl: dos ? `/api/games/${game.id}/bundle?v=${version}` : null,
        dosboxConf: dos ? dosboxConf(game) : null,
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
    if (!game || !isPlayable(game) || game.emulator !== "jsdos") return reply.code(404).send({ error: "Game not found" });
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
      .header(
        "Content-Type",
        ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg",
      )
      .header("Cache-Control", "public, max-age=86400");
    return reply.send(fs.createReadStream(cover));
  });
}

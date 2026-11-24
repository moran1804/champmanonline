// Runs inside /player.html (an iframe on the Play page). Starts js-dos for one game + save slot
// and keeps the user's save files synced to the server.
//
// Parent <-> player contract (same origin):
//   player -> parent: postMessage({ type: "cmo-status", status: SyncStatus })
//   parent -> player: iframe.contentWindow.cmo.sync() / .shutdown()  (both return Promise<boolean>)
//
// Save model: a save slot is a zip of every file the game has changed relative to the original
// bundle. On start we lay it over the bundle; on sync we merge this session's changes over it.
import { unzipSync, zipSync, type Unzipped } from "fflate";
import { api } from "../api";
import { JSDOS_BASE, loadJsDos, sha256, type CommandInterface, type DosProps } from "../emulator/jsdos";
import type { SyncStatus, PlayerApi } from "./protocol";
import { attachTouch, createInput, type TouchMouseMode } from "./input";

const params = new URLSearchParams(location.search);
const gameId = params.get("game") ?? "";
const slot = Number(params.get("slot") ?? "1");
// "smooth" uses the game's own setting (max 50%: nearly full speed, still responsive);
// "turbo" gives the emulator all the CPU it can get.
const turbo = params.get("speed") === "turbo";
const autoSyncMs = Number(params.get("autosync") ?? "30000");

let props: DosProps | null = null;
let ci: CommandInterface | null = null;
/** Files in the cloud save as last uploaded (or loaded). */
let savedFiles: Unzipped = {};
let lastHash: string | null = null;
let inFlight: Promise<boolean> | null = null;
let stopped = false;

function report(status: SyncStatus) {
  window.parent.postMessage({ type: "cmo-status", status }, location.origin);
}

/** Merge this session's changed files over the existing save. */
function mergeChanges(changes: Uint8Array): { zip: Uint8Array; files: Unzipped } {
  const files: Unzipped = { ...savedFiles };
  for (const [name, data] of Object.entries(unzipSync(changes))) {
    if (name.endsWith("/")) continue; // directory entries
    files[name] = data;
  }
  return { zip: zipSync(files, { level: 6, mtime: new Date(1994, 0, 1) }), files };
}

async function sync(opts: { keepalive?: boolean; manual?: boolean } = {}): Promise<boolean> {
  // One sync at a time; callers during a sync share its result.
  if (inFlight) return inFlight;
  const current = ci;
  if (!current) return false;
  inFlight = (async () => {
    try {
      const changes = await current.persist(true);
      const merged = changes instanceof Uint8Array ? mergeChanges(changes) : null;
      const hash = merged ? await sha256(merged.zip) : lastHash;
      if (!merged || hash === lastHash) {
        if (opts.manual) report({ kind: "nochange" });
        return true;
      }

      report({ kind: "saving" });
      await api.uploadSave(gameId, slot, merged.zip, { keepalive: opts.keepalive });
      savedFiles = merged.files;
      lastHash = hash;
      report({ kind: "saved", at: Date.now() });
      return true;
    } catch (e) {
      report({ kind: "error", message: `Cloud save failed: ${(e as Error).message}` });
      return false;
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function shutdown(): Promise<boolean> {
  if (stopped) return true;
  const ok = await sync();
  stopped = true;
  const p = props;
  props = null;
  ci = null;
  await p?.stop().catch(() => {});
  return ok;
}

const input = createInput(() => ci);
let touchMouse: TouchMouseMode = "absolute";
attachTouch(document.getElementById("dos")!, () => ci, () => touchMouse);

const playerApi: PlayerApi = {
  sync: () => sync({ manual: true }),
  shutdown,
  type: (text) => input.type(text),
  key: (k) => input.key(k),
};
(window as unknown as { cmo: PlayerApi }).cmo = playerApi;

async function fetchBundle(url: string): Promise<Uint8Array> {
  // Bundle URLs are versioned (?v=<hash>), so a cached copy is valid until the game files change.
  // Cache Storage is used rather than relying on the HTTP cache, which may evict large files
  // (CM2's bundle is ~240 MB).
  // Cache Storage only exists on secure origins (https or localhost), not on a plain-http LAN address.
  const cache = typeof caches === "undefined" ? null : await caches.open(BUNDLE_CACHE).catch(() => null);
  const cached = await cache?.match(url).catch(() => undefined);
  if (cached) {
    report({ kind: "loading", message: "Loading game from this computer…" });
    return new Uint8Array(await cached.arrayBuffer());
  }

  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok || !res.body) throw new Error(`Could not download the game (${res.status})`);
  const total = Number(res.headers.get("Content-Length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (Date.now() - lastReport > 250) {
      lastReport = Date.now();
      const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
      report({
        kind: "loading",
        message: total
          ? `Downloading game… ${Math.floor((received / total) * 100)}% (${mb(received)} of ${mb(total)} MB)`
          : `Downloading game… ${mb(received)} MB`,
      });
    }
  }
  const bundle = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    bundle.set(c, offset);
    offset += c.byteLength;
  }

  if (cache) {
    try {
      // Drop older versions of this game, then keep this one.
      const prefix = url.split("?")[0];
      for (const req of await cache.keys()) {
        if (new URL(req.url).pathname === prefix && req.url !== new URL(url, location.href).href) await cache.delete(req);
      }
      await cache.put(url, new Response(bundle, { headers: { "Content-Type": "application/zip" } }));
    } catch {
      // Storage full or unavailable: the game still runs, it just downloads again next time.
    }
  }
  return bundle;
}

const BUNDLE_CACHE = "cmo-bundles-v1";

async function start() {
  try {
    report({ kind: "loading", message: "Loading game…" });
    const { game } = await api.game(gameId);
    touchMouse = game.touchMouse ?? "absolute";

    // Fetch the save before starting. If this fails we must not start: an empty session
    // would overwrite the cloud copy on the next auto-sync.
    const [bundle, existing] = await Promise.all([fetchBundle(game.bundleUrl!), api.downloadSave(gameId, slot)]);
    if (existing) {
      savedFiles = unzipSync(existing);
      lastHash = await sha256(existing);
    }

    report({ kind: "loading", message: "Starting the emulator…" });
    const Dos = await loadJsDos();
    props = Dos(document.getElementById("dos")!, {
      dosboxConf: turbo ? game.dosboxConf!.replace(/^cycles=.*$/m, "cycles=max") : game.dosboxConf!,
      initFs: existing ? [bundle, existing] : bundle,
      pathPrefix: `${JSDOS_BASE}emulators/`,
      autoStart: true,
      kiosk: true,
      noCloud: true,
      theme: "dark",
      imageRendering: "pixelated",
      onEvent: (event, arg) => {
        if (event === "ci-ready") {
          ci = arg as CommandInterface;
          report({ kind: "running" });
        }
      },
    });
  } catch (e) {
    report({ kind: "error", message: (e as Error).message });
  }
}

window.setInterval(() => void sync(), autoSyncMs);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void sync({ keepalive: true });
});

if (!gameId || !Number.isInteger(slot)) {
  report({ kind: "error", message: "Missing game details" });
} else {
  void start();
}

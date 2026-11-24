// Runs inside /seat.html (an iframe on the Play page) for Windows games. The game itself runs on
// the server in a "seat" (Wine on a virtual screen); this page asks for a seat, then shows the
// seat's screen with noVNC and sends it the player's mouse and keyboard.
//
// It offers the Play page the same window.cmo API and status messages as the DOS player, so the
// toolbar (Save to cloud, Exit, phone keyboard) works the same for both.
// Saving is done by the server: it copies the game's changed files into the save slot every
// minute, on "Save to cloud", and when the session ends.
import RFB from "@novnc/novnc";
import type { PlayerApi, SpecialKey, SyncStatus } from "../player/protocol";
import { startSeatAudio, type SeatAudio } from "./audio";

const params = new URLSearchParams(location.search);
const gameId = params.get("game") ?? "";
const slot = Number(params.get("slot") ?? "1");

let rfb: RFB | null = null;
let audio: SeatAudio | null = null;
let stopped = false;
let connectedOnce = false;
let reconnects = 0;

function report(status: SyncStatus) {
  window.parent.postMessage({ type: "cmo-status", status }, location.origin);
}

async function post<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "POST", credentials: "same-origin" });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  rfb = new RFB(document.getElementById("screen")!, `${scheme}://${location.host}/api/seat/ws`);
  rfb.scaleViewport = true; // fit the 800×600 game to the window
  rfb.resizeSession = false;
  rfb.background = "#000";
  rfb.focusOnClick = true;
  rfb.qualityLevel = 8;
  rfb.compressionLevel = 2;
  rfb.addEventListener("connect", () => {
    connectedOnce = true;
    reconnects = 0;
    report({ kind: "running" });
    rfb?.focus();
  });
  rfb.addEventListener("disconnect", () => {
    rfb = null;
    if (stopped) return;
    // A dropped connection (Wi-Fi blip, laptop sleep): the game keeps running on the server.
    if (reconnects++ < 5) {
      report({ kind: "loading", message: "Reconnecting…" });
      setTimeout(connect, 1000 * reconnects);
    } else {
      report({ kind: "error", message: "Lost the connection to the game. Your progress is saved every minute." });
    }
  });
}

async function start() {
  try {
    report({ kind: "loading", message: "Finding a free seat…" });
    await post(`/api/seat/${encodeURIComponent(gameId)}/${slot}/start`);
    report({ kind: "loading", message: "Starting the game…" });
    connect();
    let muted = false;
    try {
      muted = localStorage.getItem("cmo-muted") === "1";
    } catch {
      // Storage blocked: start with sound on.
    }
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    audio = startSeatAudio(`${scheme}://${location.host}/api/seat/audio`, muted);
    (window as unknown as { __cmoAudio: SeatAudio }).__cmoAudio = audio;
  } catch (e) {
    report({ kind: "error", message: (e as Error).message });
  }
}

async function sync(): Promise<boolean> {
  if (stopped) return true;
  try {
    report({ kind: "saving" });
    const { result } = await post<{ result: "saved" | "nochange" }>("/api/seat/sync");
    report(result === "saved" ? { kind: "saved", at: Date.now() } : { kind: "nochange" });
    return true;
  } catch (e) {
    report({ kind: "error", message: `Cloud save failed: ${(e as Error).message}` });
    return false;
  }
}

async function shutdown(): Promise<boolean> {
  if (stopped) return true;
  stopped = true;
  try {
    await post("/api/seat/stop"); // saves, then frees the seat
    return true;
  } catch {
    return false;
  } finally {
    rfb?.disconnect();
    audio?.stop();
  }
}

// X11 keysyms for keys phone keyboards don't have.
const KEYSYMS: Record<string, number> = {
  enter: 0xff0d,
  esc: 0xff1b,
  backspace: 0xff08,
  tab: 0xff09,
  up: 0xff52,
  down: 0xff54,
  left: 0xff51,
  right: 0xff53,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  delete: 0xffff,
};

function keysymFor(ch: string): number {
  if (ch === "\n") return KEYSYMS.enter;
  const code = ch.codePointAt(0)!;
  return code < 0x100 ? code : 0x01000000 + code; // Latin-1 keysyms equal the code; others are Unicode keysyms
}

const playerApi: PlayerApi = {
  sync,
  shutdown,
  setMuted: (m) => audio?.setMuted(m),
  type(text) {
    for (const ch of text) rfb?.sendKey(keysymFor(ch), null);
    noteActivity();
  },
  key(k: SpecialKey) {
    const sym = /^f\d+$/.test(k) ? 0xffbe + Number(k.slice(1)) - 1 : KEYSYMS[k];
    if (sym) rfb?.sendKey(sym, null);
    noteActivity();
  },
};
(window as unknown as { cmo: PlayerApi }).cmo = playerApi;

// Tell the server the player is still here (at most once a minute) so the seat isn't freed as idle.
let lastPing = 0;
function noteActivity() {
  if (stopped || Date.now() - lastPing < 60_000) return;
  lastPing = Date.now();
  void post("/api/seat/ping").catch(() => {});
}
for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) {
  window.addEventListener(ev, noteActivity, { capture: true, passive: true });
}

// Notice when the game has been closed from inside (its own "Exit Game"): the server has already
// saved and freed the seat by then.
setInterval(async () => {
  if (stopped || !connectedOnce) return;
  try {
    const res = await fetch("/api/seat/status", { credentials: "same-origin" });
    const s = (await res.json()) as { active: boolean; running?: boolean };
    if (!s.active || s.running === false) {
      stopped = true;
      rfb?.disconnect();
      audio?.stop();
      report({ kind: "error", message: "The game has closed. Your progress has been saved to the cloud." });
    }
  } catch {
    // Temporary network trouble: the reconnect logic deals with it.
  }
}, 15_000);

if (!gameId || !Number.isInteger(slot)) {
  report({ kind: "error", message: "Missing game details" });
} else {
  void start();
}

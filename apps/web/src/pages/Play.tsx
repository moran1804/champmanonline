import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type GameDetail } from "../api";
import type { PlayerApi, SyncStatus } from "../player/protocol";
import { ResultsLookup } from "../components/ResultsLookup";
import { SoftKeyboard, type SoftKeyboardHandle } from "../components/SoftKeyboard";
import { useMediaQuery } from "../hooks/useMediaQuery";

function statusText(s: SyncStatus): string {
  switch (s.kind) {
    case "loading":
      return s.message;
    case "running":
      return "Playing · saves sync automatically";
    case "nochange":
      return "Nothing new to upload. Save inside the game first.";
    case "saving":
      return "Saving to cloud…";
    case "saved":
      return `Saved to cloud at ${new Date(s.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    case "error":
      return s.message;
  }
}

/** Keeps the player sized to the visible area, which shrinks when the phone keyboard opens. */
function useVisualViewportSize() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty("--app-h", `${vv.height}px`);
      root.style.setProperty("--app-top", `${vv.offsetTop}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--app-h");
      root.style.removeProperty("--app-top");
    };
  }, []);
}

function loadMuted(): boolean {
  try {
    return localStorage.getItem("cmo-muted") === "1";
  } catch {
    return false;
  }
}

type Speed = "smooth" | "turbo";
const SPEED_KEY = "cmo-speed";
function loadSpeed(): Speed {
  try {
    return localStorage.getItem(SPEED_KEY) === "turbo" ? "turbo" : "smooth";
  } catch {
    return "smooth";
  }
}

export function PlayPage() {
  const { gameId = "", slot: slotParam = "1" } = useParams();
  const slot = Number(slotParam);
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const kbRef = useRef<SoftKeyboardHandle>(null);
  const [game, setGame] = useState<GameDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus>({ kind: "loading", message: "Loading…" });
  const [exiting, setExiting] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [portraitDismissed, setPortraitDismissed] = useState(false);
  const [speed, setSpeed] = useState<Speed>(loadSpeed);
  const [muted, setMuted] = useState(loadMuted);
  const autoShownRef = useRef(false);

  const touch = useMediaQuery("(any-pointer: coarse)");
  const portrait = useMediaQuery("(orientation: portrait)");
  // Phones held sideways: put the controls in the black bars beside the 4:3 picture so the
  // game gets the full screen height.
  const shortLandscape = useMediaQuery("(orientation: landscape) and (max-height: 520px)");
  const rails = touch && shortLandscape;
  const canFullscreen = typeof document !== "undefined" && !!document.fullscreenEnabled;
  useVisualViewportSize();

  // On touch devices, go full screen as the game opens. This uses the tap that started the game
  // (browsers only allow it shortly after a tap); where it isn't allowed it silently does nothing.
  useEffect(() => {
    if (!touch || !document.fullscreenEnabled || document.fullscreenElement) return;
    document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    return () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [touch]);

  // The manual check comes up as the game starts, so open the results overlay then (once).
  useEffect(() => {
    if (status.kind === "running" && game?.hasLookup && !autoShownRef.current) {
      autoShownRef.current = true;
      setShowResults(true);
    }
  }, [status.kind, game?.hasLookup]);

  function focusGame() {
    iframeRef.current?.focus();
    iframeRef.current?.contentWindow?.focus();
  }

  const player = () => (iframeRef.current?.contentWindow as unknown as { cmo?: PlayerApi } | null)?.cmo;

  useEffect(() => {
    api
      .game(gameId)
      .then((r) => setGame(r.game))
      .catch((e) => setError((e as Error).message));
  }, [gameId]);

  useEffect(() => {
    if (game) document.title = `${game.title} · RetroPCGames`;
    return () => {
      document.title = "RetroPCGames";
    };
  }, [game]);

  // Status updates from the player iframe.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as { type?: string; status?: SyncStatus };
      if (data?.type === "cmo-status" && data.status) setStatus(data.status);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Ask before closing the tab, because the last few seconds of changes may not be uploaded yet.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (exiting) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [exiting]);

  async function exit() {
    setExiting(true);
    const ok = (await player()?.shutdown().catch(() => false)) ?? true;
    if (!ok && !window.confirm("Your latest progress could not be saved to the cloud. Leave anyway?")) {
      setExiting(false);
      return;
    }
    navigate(`/games/${gameId}`);
  }

  // The emulator can't change speed while running, so switching saves and restarts the game.
  async function changeSpeed() {
    const next: Speed = speed === "smooth" ? "turbo" : "smooth";
    const msg =
      (next === "turbo"
        ? "Turbo runs the game as fast as your device allows, but clicks and screen updates can feel less responsive."
        : "Smooth runs slightly slower but feels more responsive.") +
      "\n\nThe game will restart. Save inside the game first; you can then load your save again.";
    if (!window.confirm(msg)) return;
    setExiting(true);
    const ok = (await player()?.shutdown().catch(() => false)) ?? true;
    setExiting(false);
    if (!ok && !window.confirm("Your latest progress could not be saved to the cloud. Restart anyway?")) return;
    try {
      localStorage.setItem(SPEED_KEY, next);
    } catch {
      // Not stored; the choice still applies until the page is closed.
    }
    setStatus({ kind: "loading", message: "Restarting…" });
    setSpeed(next);
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    try {
      localStorage.setItem("cmo-muted", next ? "1" : "0");
    } catch {
      // Not remembered; still applies now.
    }
    player()?.setMuted?.(next);
    focusGame();
  }

  function toggleKeyboard() {
    if (kbOpen) kbRef.current?.close();
    else kbRef.current?.open();
  }

  if (error) {
    return (
      <div className="play-error">
        <p className="error">{error}</p>
        <button className="btn" onClick={() => navigate("/")}>
          Back to games
        </button>
      </div>
    );
  }

  // Windows games stream from a server-side seat; DOS games run in the browser.
  const windows = game?.emulator === "wine";
  const src = !game
    ? null
    : windows
      ? `/seat.html?${new URLSearchParams({ game: game.id, slot: String(slot) })}`
      : `/player.html?${new URLSearchParams({ game: game.id, slot: String(slot), speed })}`;
  const busy = status.kind === "loading" || status.kind === "saving" || exiting;

  const statusEl = (
    <span className={`sync-status status-${status.kind}`} role="status" title={statusText(status)}>
      <span className="dot" aria-hidden />
      <span className="sync-text">{statusText(status)}</span>
    </span>
  );
  const exitBtn = (
    <button className="btn ghost small" onClick={exit} disabled={exiting} title="Exit game">
      <span aria-hidden>←</span>
      <span className="lbl">{exiting ? "Saving…" : "Exit game"}</span>
    </button>
  );
  const keyboardBtn = touch && (
    <button
      className={`btn small ${kbOpen ? "primary" : "ghost"}`}
      onClick={toggleKeyboard}
      title={kbOpen ? "Hide keyboard" : "Show keyboard"}
      aria-pressed={kbOpen}
    >
      <span aria-hidden>⌨</span>
      <span className="lbl">Keyboard</span>
    </button>
  );
  const saveBtn = (
    <button
      className="btn small"
      onClick={() => void player()?.sync()}
      disabled={busy}
      title="Save inside the game first, then press this to upload straight away"
    >
      <span aria-hidden>☁</span>
      <span className="lbl">Save to cloud</span>
    </button>
  );
  const resultsBtn = game?.hasLookup && (
    <button
      className={`btn small ${showResults ? "primary" : "ghost"}`}
      onClick={() => setShowResults((v) => !v)}
      title="Look up the answer the game asks for"
    >
      <span aria-hidden>🔎</span>
      <span className="lbl">Results</span>
    </button>
  );
  const manualBtn = game?.hasManual && (
    <button
      className={`btn small ${showManual ? "primary" : "ghost"}`}
      onClick={() => setShowManual((v) => !v)}
      title="Game manual"
    >
      <span aria-hidden>📖</span>
      <span className="lbl">Manual</span>
    </button>
  );
  // Sound for Windows games is streamed from the seat; DOS games play sound in the browser.
  const soundBtn = windows && (
    <button
      className={`btn small ${muted ? "primary" : "ghost"}`}
      onClick={toggleMute}
      title={muted ? "Sound off (tap to turn on)" : "Sound on (tap to mute)"}
      aria-pressed={muted}
    >
      <span aria-hidden>{muted ? "🔇" : "🔊"}</span>
      <span className="lbl">{muted ? "Muted" : "Sound"}</span>
    </button>
  );
  // Speed only applies to the DOS emulator.
  const speedBtn = !windows && (
    <button
      className={`btn small ${speed === "turbo" ? "primary" : "ghost"}`}
      onClick={() => void changeSpeed()}
      disabled={busy}
      title={speed === "turbo" ? "Speed: Turbo (tap for Smooth)" : "Speed: Smooth (tap for Turbo)"}
    >
      <span aria-hidden>{speed === "turbo" ? "⏩" : "▶"}</span>
      <span className="lbl">{speed === "turbo" ? "Turbo" : "Smooth"}</span>
    </button>
  );
  const fullscreenBtn = canFullscreen && (
    <button
      className="btn ghost small"
      onClick={() =>
        void (document.fullscreenElement
          ? document.exitFullscreen()
          : (touch ? document.documentElement : frameRef.current)?.requestFullscreen())
      }
      title="Full screen"
    >
      <span aria-hidden>⛶</span>
      <span className="lbl">Full screen</span>
    </button>
  );

  return (
    <div className={`play ${touch ? "touch" : ""} ${rails ? "rails" : ""}`} ref={frameRef}>
      {!rails && (
        <div className="play-toolbar">
          {exitBtn}
          <div className="play-title">
            <strong>{game?.title ?? "Loading…"}</strong>
            <span className="muted small slot-label">Save slot {slot}</span>
          </div>
          {statusEl}
          {keyboardBtn}
          {saveBtn}
          {resultsBtn}
          {manualBtn}
          {speedBtn}
          {soundBtn}
          {fullscreenBtn}
        </div>
      )}

      {touch && (
        <SoftKeyboard
          ref={kbRef}
          open={kbOpen}
          onOpenChange={setKbOpen}
          onType={(t) => player()?.type(t)}
          onKey={(k) => player()?.key(k)}
        />
      )}

      <div className="play-body">
        {rails && (
          <>
            <div className="rail left">
              {exitBtn}
              {saveBtn}
              {statusEl}
            </div>
            <div className="rail right">
              {keyboardBtn}
              {resultsBtn}
              {manualBtn}
              {speedBtn}
              {soundBtn}
              {fullscreenBtn}
            </div>
          </>
        )}
        {status.kind === "loading" && rails && <div className="rail-loading">{statusText(status)}</div>}
        {src && (
          <iframe
            key={speed}
            ref={iframeRef}
            className="player-frame"
            src={src}
            title={game?.title ?? "Game"}
            allow="fullscreen; autoplay; gamepad"
            onLoad={() => !touch && iframeRef.current?.contentWindow?.focus()}
          />
        )}

        {touch && portrait && !portraitDismissed && !kbOpen && (
          <div className="rotate-hint" role="note">
            <span>📱↻ Turn your phone sideways for a bigger picture.</span>
            <button className="btn ghost small" onClick={() => setPortraitDismissed(true)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        {showResults && game && (
          <div className="results-overlay" role="dialog" aria-label="Manual results">
            <div className="results-overlay-head">
              <strong>Manual results</strong>
              <button
                className="btn ghost small"
                onClick={() => {
                  setShowResults(false);
                  if (!touch) focusGame();
                }}
                aria-label="Close results"
              >
                ✕
              </button>
            </div>
            <p className="muted small overlay-help">
              {touch
                ? "Look up the answer, then tap Type answer to enter it."
                : "Type the page number the game asks about, then click the game and enter the score."}
            </p>
            {/* No auto-focus on touch screens: it would pop up the keyboard over the game. */}
            <ResultsLookup gameId={game.id} compact autoFocus={!touch} />
            {touch && (
              <button
                className="btn primary small type-answer"
                onClick={() => {
                  setShowResults(false);
                  kbRef.current?.open(); // must run inside the tap for the phone to show its keyboard
                }}
              >
                ⌨ Type answer
              </button>
            )}
          </div>
        )}

        {showManual && game && (
          <aside className="manual-panel">
            <div className="manual-head">
              <div className="manual-head-row">
                <strong>Game manual</strong>
                <button className="btn ghost small" onClick={() => setShowManual(false)} aria-label="Close manual">
                  ✕
                </button>
              </div>
              <span className="muted small">Look up the answer, then go back to the game to enter it.</span>
              {game.hasManual && (
                <a href={`/api/games/${game.id}/manual`} target="_blank" rel="noreferrer" className="small">
                  Open in new tab ↗
                </a>
              )}
            </div>
            {game.hasManual ? (
              <iframe className="manual-frame" src={`/api/games/${game.id}/manual#view=FitH`} title="Game manual" />
            ) : (
              <p className="muted manual-empty">
                No manual has been added for this game yet. An admin can add one by putting a PDF with "manual" in its
                name into the game's folder.
              </p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

// Touch and on-screen-keyboard input for the DOS emulator.
//
// Touch: js-dos maps touches to the DOS mouse, but a tap's press and release arrive together and
// the old CM games, which poll the button state, never see the click. We take over touch input and
//   - tap        → move there, hold the left button briefly, release (a click the game can see)
//   - long-press → right click
//   - drag       → left button held while moving
//
// Keyboard: phones' keyboards produce text, not DOS key codes, so text is translated into key
// presses here (adding Shift for capitals/symbols on a US layout, which is DOSBox's default).

/** The parts of the js-dos CommandInterface used for input. */
export interface InputCI {
  sendKeyEvent(keyCode: number, pressed: boolean): void;
  sendMouseMotion(x: number, y: number): void;
  sendMouseRelativeMotion(dx: number, dy: number): void;
  width(): number;
  height(): number;
  sendMouseButton(button: number, pressed: boolean): void;
}

// js-dos key codes (GLFW-style), from emulators' KBD_* table.
const K = {
  enter: 257,
  esc: 256,
  backspace: 259,
  tab: 258,
  space: 32,
  shift: 340,
  delete: 261,
  up: 265,
  down: 264,
  left: 263,
  right: 262,
  home: 268,
  end: 269,
  pageup: 266,
  pagedown: 267,
  f1: 290,
} as const;

export type SpecialKey =
  | "enter"
  | "esc"
  | "backspace"
  | "tab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "delete"
  | `f${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;

function specialCode(key: SpecialKey): number {
  if (/^f\d+$/.test(key)) return K.f1 + Number(key.slice(1)) - 1;
  return K[key as keyof typeof K];
}

const UNSHIFTED: Record<string, number> = {
  " ": 32, "-": 45, "=": 61, "[": 91, "]": 93, "\\": 92, ";": 59, "'": 39, ",": 44, ".": 46, "/": 47, "`": 96,
};
const SHIFTED: Record<string, number> = {
  "!": 49, "@": 50, "#": 51, $: 52, "%": 53, "^": 54, "&": 55, "*": 56, "(": 57, ")": 48,
  _: 45, "+": 61, "{": 91, "}": 93, "|": 92, ":": 59, '"': 39, "<": 44, ">": 46, "?": 47, "~": 96,
};

/** Maps one character to [keyCode, needsShift], or null if it can't be typed. */
function charToKey(ch: string): [number, boolean] | null {
  if (ch >= "a" && ch <= "z") return [ch.charCodeAt(0) - 32, false];
  if (ch >= "A" && ch <= "Z") return [ch.charCodeAt(0), true];
  if (ch >= "0" && ch <= "9") return [ch.charCodeAt(0), false];
  if (ch === "\n" || ch === "\r") return [K.enter, false];
  if (ch === "\t") return [K.tab, false];
  if (ch in UNSHIFTED) return [UNSHIFTED[ch]!, false];
  if (ch in SHIFTED) return [SHIFTED[ch]!, true];
  // Common phone-keyboard substitutions.
  if (ch === "’" || ch === "‘") return [39, false]; // curly apostrophes
  if (ch === "“" || ch === "”") return [39, true]; // curly quotes
  if (ch === "–" || ch === "—") return [45, false]; // en/em dash
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createInput(getCi: () => InputCI | null) {
  // Key presses are queued and played at a steady pace so the DOS keyboard buffer keeps up.
  let queue: Promise<void> = Promise.resolve();
  const press = (code: number, shift: boolean) => {
    queue = queue.then(async () => {
      const ci = getCi();
      if (!ci) return;
      if (shift) ci.sendKeyEvent(K.shift, true);
      ci.sendKeyEvent(code, true);
      await sleep(40);
      ci.sendKeyEvent(code, false);
      if (shift) ci.sendKeyEvent(K.shift, false);
      await sleep(25);
    });
  };

  return {
    type(text: string) {
      for (const ch of text) {
        const k = charToKey(ch);
        if (k) press(k[0], k[1]);
      }
    },
    key(key: SpecialKey) {
      press(specialCode(key), false);
    },
  };
}

/**
 * How taps move the DOS mouse:
 *  - "absolute": position set directly (works for games that read the cursor position, e.g. CM1, 93/94).
 *  - "relative": for games that only read mouse movement (the CM2 engine: CM2, 96/97, 97/98). The
 *    pointer is parked in the top-left corner, then moved by the exact distance in screen pixels.
 */
export type TouchMouseMode = "absolute" | "relative";

/** Takes over touch input on the emulator canvas. Returns a cleanup function. */
export function attachTouch(
  root: HTMLElement,
  getCi: () => InputCI | null,
  getMode: () => TouchMouseMode = () => "absolute",
): () => void {
  const LONG_PRESS_MS = 550;
  const DRAG_PX = 12;
  const CLICK_HOLD_MS = 90;

  let active: {
    id: number;
    startX: number;
    startY: number;
    dragging: boolean;
    longPressTimer: number;
    done: boolean;
  } | null = null;

  const canvasPoint = (clientX: number, clientY: number): [number, number] | null => {
    const canvas = root.querySelector("canvas");
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    return [x, y];
  };

  // Relative mode: where we believe the DOS pointer is, in screen pixels.
  let pos: [number, number] | null = null;
  // Moves are chained so a click always happens after the pointer has arrived.
  let moving: Promise<void> = Promise.resolve();

  const target = (ci: InputCI, p: [number, number]): [number, number] => [
    Math.round(p[0] * (ci.width() - 1)),
    Math.round(p[1] * (ci.height() - 1)),
  ];

  /** Move the pointer to the touch point. `exact` re-parks it in the corner first (taps); drags just follow. */
  const moveTo = (e: PointerEvent, exact: boolean) => {
    const ci = getCi();
    const p = canvasPoint(e.clientX, e.clientY);
    if (!ci || !p) return;
    if (getMode() === "absolute") {
      ci.sendMouseMotion(p[0], p[1]);
      return;
    }
    moving = moving.then(async () => {
      const t = target(ci, p);
      if (exact || !pos) {
        ci.sendMouseRelativeMotion(-10000, -10000); // pinned at 0,0 by the game
        await sleep(60); // let the game read the move before the next one
        pos = [0, 0];
      }
      ci.sendMouseRelativeMotion(t[0] - pos[0], t[1] - pos[1]);
      pos = t;
      await sleep(exact ? 60 : 0);
    });
  };

  const click = async (button: number) => {
    await moving;
    const ci = getCi();
    if (!ci) return;
    ci.sendMouseButton(button, true);
    await sleep(CLICK_HOLD_MS);
    ci.sendMouseButton(button, false);
  };

  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    swallow(e);
    if (active) return; // ignore extra fingers
    moveTo(e, true);
    active = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      done: false,
      longPressTimer: window.setTimeout(() => {
        if (active && !active.dragging) {
          active.done = true;
          void click(1); // right button (DOS button 1)
          navigator.vibrate?.(15);
        }
      }, LONG_PRESS_MS),
    };
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    swallow(e);
    if (!active || e.pointerId !== active.id || active.done) return;
    if (!active.dragging && Math.hypot(e.clientX - active.startX, e.clientY - active.startY) > DRAG_PX) {
      active.dragging = true;
      clearTimeout(active.longPressTimer);
      moving = moving.then(() => getCi()?.sendMouseButton(0, true));
    }
    if (active.dragging) moveTo(e, false);
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    swallow(e);
    if (!active || e.pointerId !== active.id) return;
    clearTimeout(active.longPressTimer);
    if (active.dragging) {
      moveTo(e, false);
      moving = moving.then(() => getCi()?.sendMouseButton(0, false));
    } else if (!active.done && e.type === "pointerup") {
      void click(0);
    }
    active = null;
  };

  // Capture phase on the window, so js-dos' own pointer handlers never see touches.
  const opts = { capture: true, passive: false } as const;
  const touchBlock = (e: TouchEvent) => {
    if (root.contains(e.target as Node)) e.preventDefault(); // no scrolling, zooming or synthetic mouse events
  };
  window.addEventListener("pointerdown", onDown, opts);
  window.addEventListener("pointermove", onMove, opts);
  window.addEventListener("pointerup", onUp, opts);
  window.addEventListener("pointercancel", onUp, opts);
  window.addEventListener("touchstart", touchBlock, opts);
  window.addEventListener("touchmove", touchBlock, opts);
  return () => {
    window.removeEventListener("pointerdown", onDown, opts);
    window.removeEventListener("pointermove", onMove, opts);
    window.removeEventListener("pointerup", onUp, opts);
    window.removeEventListener("pointercancel", onUp, opts);
    window.removeEventListener("touchstart", touchBlock, opts);
    window.removeEventListener("touchmove", touchBlock, opts);
  };
}

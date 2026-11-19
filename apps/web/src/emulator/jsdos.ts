// Minimal typings for the parts of the js-dos player API we use.
//
// Pinned to js-dos 8.3.20: in testing (Nov 2026), 8.4.x–8.5.4 never reached "ci-ready" for any
// bundle, while 8.3.20 boots CM 93/94 fine. Re-test before upgrading.

export interface CommandInterface {
  /** Zip of the files changed during this session, or null if nothing changed. */
  persist(onlyChanges?: boolean): Promise<Uint8Array | null | object>;
  sendKeyEvent(keyCode: number, pressed: boolean): void;
  /** Absolute position, 0..1 across the screen. */
  sendMouseMotion(x: number, y: number): void;
  /** Movement in screen pixels (for games that only read mouse movement). */
  sendMouseRelativeMotion(dx: number, dy: number): void;
  width(): number;
  height(): number;
  /** 0 = left, 1 = right (js-dos maps every non-left browser button to 1). */
  sendMouseButton(button: number, pressed: boolean): void;
}

/** A zip archive (bundle or save changes) or a single file to place in the DOS filesystem. */
export type InitFsEntry = Uint8Array | { path: string; contents: Uint8Array };

export interface DosOptions {
  /** dosbox.conf text. With 8.3.x, initFs is only applied when this is used instead of `url`. */
  dosboxConf: string;
  /** Applied in order: later archives overwrite earlier files. */
  initFs: InitFsEntry | InitFsEntry[];
  pathPrefix?: string;
  autoStart?: boolean;
  kiosk?: boolean;
  noCloud?: boolean;
  theme?: string;
  imageRendering?: "pixelated" | "smooth";
  onEvent?: (event: string, arg?: unknown) => void;
}

export interface DosProps {
  stop(): Promise<void>;
  setFullScreen(fullScreen: boolean): void;
}

declare global {
  interface Window {
    Dos?: (element: HTMLElement, options: DosOptions) => DosProps;
  }
}

export const JSDOS_BASE = "/jsdos/";

let loader: Promise<NonNullable<Window["Dos"]>> | null = null;

/** Injects the self-hosted js-dos stylesheet and script once, resolving to window.Dos. */
export function loadJsDos(): Promise<NonNullable<Window["Dos"]>> {
  if (window.Dos) return Promise.resolve(window.Dos);
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `${JSDOS_BASE}js-dos.css`;
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = `${JSDOS_BASE}js-dos.js`;
    script.async = true;
    script.onload = () => (window.Dos ? resolve(window.Dos) : reject(new Error("js-dos did not load")));
    script.onerror = () => {
      loader = null;
      reject(new Error("Could not load the emulator"));
    };
    document.head.appendChild(script);
  });
  return loader;
}

export async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type SyncStatus =
  | { kind: "loading"; message: string }
  | { kind: "running" }
  | { kind: "nochange" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

/** Exposed by player.html as window.cmo for the parent Play page. */
import type { SpecialKey } from "./input";
export type { SpecialKey };

export type PlayerApi = {
  /** Type text into the game (from the phone keyboard). */
  type: (text: string) => void;
  /** Press a key phone keyboards don't have (Esc, arrows, F-keys…) or Enter/Backspace. */
  key: (key: SpecialKey) => void;
  /** Upload the current save files now. Resolves true when the cloud copy is up to date. */
  sync: () => Promise<boolean>;
  /** Final sync, then stop the emulator. */
  shutdown: () => Promise<boolean>;
  /** Mute or unmute game sound (Windows games; DOS games don't offer it). */
  setMuted?: (muted: boolean) => void;
};

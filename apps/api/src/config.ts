import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  port: Number(env("PORT", "8080")),
  host: env("HOST", "0.0.0.0"),
  /** SQLite database, save files and bundle cache live here. */
  dataDir: path.resolve(env("DATA_DIR", path.join(repoRoot, "data"))),
  /** Folder holding one sub-folder per game version (the original "Game Files" folder). */
  gamesRoot: path.resolve(env("GAMES_ROOT", path.join(repoRoot, "Game Files"))),
  catalogPath: path.resolve(env("CATALOG_PATH", path.join(repoRoot, "games/catalog.json"))),
  /** Built React app. */
  webDir: path.resolve(env("WEB_DIR", path.join(repoRoot, "apps/web/dist"))),
  /** Set to "false" for plain-http local development. */
  cookieSecure: env("COOKIE_SECURE", "true") !== "false",
  sessionDays: Number(env("SESSION_DAYS", "30")),
  adminEmail: process.env.ADMIN_EMAIL ?? "",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  adminUsername: env("ADMIN_USERNAME", "admin"),
  /** If true, new sign-ups wait for an admin to approve them before they can play. */
  requireApproval: env("REQUIRE_APPROVAL", "false") === "true",
  /** Max save slots per user per game. */
  maxSlots: Number(env("MAX_SLOTS", "5")),
  /** Max size of one uploaded save archive. */
  maxSaveBytes: Number(env("MAX_SAVE_BYTES", String(200 * 1024 * 1024))),
  /** Windows-game seat containers (host names on the app's network), e.g. "seat1,seat2". Empty = none. */
  seats: env("SEATS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Shared secret for the app → seat agent API. */
  seatToken: env("SEAT_TOKEN", ""),
  /** A seat is freed after this many minutes with no mouse or keyboard input. */
  seatIdleMinutes: Number(env("SEAT_IDLE_MINUTES", "30")),
};

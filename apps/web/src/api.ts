export type User = {
  id: number;
  email: string | null;
  username: string;
  role: "user" | "admin";
  status: "pending" | "approved" | "rejected";
  created_at: number;
};

export type GameSummary = {
  id: string;
  title: string;
  year: number;
  platform: "dos" | "windows";
  category: string;
  playable: boolean;
  /** Why it can't be played, if it never will be (otherwise it's "Coming soon"). */
  unavailable: string | null;
  hasCover: boolean;
};

export type GameDetail = {
  id: string;
  title: string;
  year: number;
  platform: "dos" | "windows";
  emulator: "jsdos" | "wine";
  /** DOS games only. */
  bundleUrl: string | null;
  dosboxConf: string | null;
  hasManual: boolean;
  hasLookup: boolean;
  note: string | null;
  touchMouse: "absolute" | "relative";
  /** Desktop: the game captures the mouse when clicked (Esc releases). */
  mouseLock: boolean;
  maxSlots: number;
};

export type LookupTable = { title: string; headers: string[]; rows: string[][] };

export type SaveSlot = {
  slot: number;
  label: string;
  size: number;
  createdAt: number;
  updatedAt: number;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const api = {
  me: () => request<{ user: User | null }>("GET", "/api/auth/me"),
  login: (login: string, password: string) => request<{ user: User }>("POST", "/api/auth/login", { login, password }),
  register: (username: string, password: string) =>
    request<{ user: User }>("POST", "/api/auth/register", { username, password }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", {}),

  games: () => request<{ games: GameSummary[] }>("GET", "/api/games"),
  game: (id: string) => request<{ game: GameDetail }>("GET", `/api/games/${id}`),
  lookup: (id: string) => request<LookupTable>("GET", `/api/games/${id}/lookup`),

  saves: (gameId: string) => request<{ saves: SaveSlot[]; maxSlots: number }>("GET", `/api/saves/${gameId}`),
  renameSave: (gameId: string, slot: number, label: string) =>
    request<{ ok: true }>("PATCH", `/api/saves/${gameId}/${slot}`, { label }),
  deleteSave: (gameId: string, slot: number) => request<{ ok: true }>("DELETE", `/api/saves/${gameId}/${slot}`),

  /** Raw js-dos changes archive for a slot, or null if the slot is empty. */
  async downloadSave(gameId: string, slot: number): Promise<Uint8Array | null> {
    const res = await fetch(`/api/saves/${gameId}/${slot}`, { credentials: "same-origin", cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, "Could not load your save");
    return new Uint8Array(await res.arrayBuffer());
  },

  async uploadSave(gameId: string, slot: number, data: Uint8Array, opts: { keepalive?: boolean } = {}) {
    const res = await fetch(`/api/saves/${gameId}/${slot}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/octet-stream" },
      body: data as BodyInit,
      // keepalive lets the final upload finish while the tab is closing (64 KB browser limit).
      keepalive: opts.keepalive && data.byteLength < 60 * 1024,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, (body as { error?: string }).error ?? "Upload failed");
    }
    return ((await res.json()) as { save: SaveSlot }).save;
  },

  admin: {
    users: () => request<{ users: User[] }>("GET", "/api/admin/users"),
    resetPassword: (id: number, password: string) =>
      request<{ ok: true }>("POST", `/api/admin/users/${id}/password`, { password }),
    setStatus: (id: number, status: User["status"]) =>
      request<{ ok: true }>("POST", `/api/admin/users/${id}/status`, { status }),
  },
};

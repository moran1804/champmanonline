import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.ts";
import { db, toPublic, type User } from "./db.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";

export const SESSION_COOKIE = "cmo_session";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

const findSessionUser = db.prepare(
  `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`,
);
const insertSession = db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`);
const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);
const purgeSessions = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`);
const findUserByLogin = db.prepare(`SELECT * FROM users WHERE username = ? OR email = ?`);
const findUserByUsername = db.prepare(`SELECT * FROM users WHERE username = ?`);
const insertUser = db.prepare(
  `INSERT INTO users (email, username, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
);

function hashToken(token: string): string {
  // Only a hash of the session token is stored, so a leaked database can't be used to log in.
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createSession(reply: FastifyReply, userId: number) {
  const token = crypto.randomBytes(32).toString("base64url");
  const maxAge = config.sessionDays * 24 * 60 * 60;
  insertSession.run(hashToken(token), userId, Date.now() + maxAge * 1000);
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    maxAge,
  });
}

/** The signed-in user for a raw Cookie header (for WebSocket upgrades, which bypass Fastify's hooks). */
export function userFromCookieHeader(header: string | undefined): User | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== SESSION_COOKIE) continue;
    const token = decodeURIComponent(part.slice(i + 1).trim());
    return (findSessionUser.get(hashToken(token), Date.now()) as User | undefined) ?? null;
  }
  return null;
}

export function requireUser(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  if (!req.user) {
    reply.code(401).send({ error: "Not signed in" });
    return;
  }
  done();
}

export function requireApproved(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  if (!req.user) {
    reply.code(401).send({ error: "Not signed in" });
    return;
  }
  if (req.user.status !== "approved") {
    reply.code(403).send({ error: "Your account is awaiting approval" });
    return;
  }
  done();
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  if (!req.user || req.user.role !== "admin" || req.user.status !== "approved") {
    reply.code(403).send({ error: "Admins only" });
    return;
  }
  done();
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;

export async function ensureAdmin(log: FastifyInstance["log"]) {
  if (!config.adminPassword) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number };
    if (n === 0) log.warn("No admin account exists. Set ADMIN_USERNAME and ADMIN_PASSWORD to create one.");
    return;
  }
  const existing = findUserByUsername.get(config.adminUsername) as User | undefined;
  if (existing) {
    if (existing.role !== "admin" || existing.status !== "approved") {
      db.prepare(`UPDATE users SET role = 'admin', status = 'approved' WHERE id = ?`).run(existing.id);
    }
    return;
  }
  insertUser.run(
    config.adminEmail || null,
    config.adminUsername,
    await hashPassword(config.adminPassword),
    "admin",
    "approved",
    Date.now(),
  );
  log.info(`Created admin account "${config.adminUsername}"`);
}

export async function authRoutes(app: FastifyInstance) {
  // Resolve the session cookie on every request.
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    req.user = (findSessionUser.get(hashToken(token), Date.now()) as User | undefined) ?? null;
  });

  // Cheap periodic cleanup of expired sessions.
  const timer = setInterval(() => purgeSessions.run(Date.now()), 60 * 60 * 1000);
  timer.unref();

  const strictLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/register",
    strictLimit,
    async (req, reply) => {
      const username = String(req.body?.username ?? "").trim();
      const password = String(req.body?.password ?? "");
      if (!USERNAME_RE.test(username))
        return reply.code(400).send({ error: "Username must be 3-24 letters, numbers, dots, dashes or underscores" });
      if (password.length < 8) return reply.code(400).send({ error: "Password must be at least 8 characters" });
      if (findUserByUsername.get(username)) return reply.code(409).send({ error: "That username is already taken" });

      const status = config.requireApproval ? "pending" : "approved";
      const info = insertUser.run(null, username, await hashPassword(password), "user", status, Date.now());
      createSession(reply, Number(info.lastInsertRowid));
      const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid) as User;
      return { user: toPublic(user) };
    },
  );

  app.post<{ Body: { login?: string; password?: string } }>("/api/auth/login", strictLimit, async (req, reply) => {
    const login = String(req.body?.login ?? "").trim();
    const password = String(req.body?.password ?? "");
    const user = findUserByLogin.get(login, login) as User | undefined;
    // Always run a hash check so response timing doesn't reveal whether the account exists.
    const ok = user
      ? await verifyPassword(password, user.password_hash)
      : (await verifyPassword(password, DUMMY_HASH), false);
    if (!user || !ok) return reply.code(401).send({ error: "Wrong username/email or password" });
    if (user.status === "rejected") return reply.code(403).send({ error: "This account has been disabled" });
    createSession(reply, user.id);
    return { user: toPublic(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deleteSession.run(hashToken(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    return { user: req.user ? toPublic(req.user) : null };
  });
}

const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString("hex"));

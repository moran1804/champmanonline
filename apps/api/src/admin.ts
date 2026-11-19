import type { FastifyInstance } from "fastify";
import { db, toPublic, type User } from "./db.ts";
import { requireAdmin } from "./auth.ts";
import { hashPassword } from "./passwords.ts";

export async function adminRoutes(app: FastifyInstance) {
  app.get("/api/admin/users", { preHandler: requireAdmin }, async () => {
    const users = db.prepare(`SELECT * FROM users ORDER BY status = 'pending' DESC, created_at DESC`).all() as User[];
    return { users: users.map(toPublic) };
  });

  app.post<{ Params: { id: string }; Body: { status?: string } }>(
    "/api/admin/users/:id/status",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      const status = req.body?.status;
      if (status !== "approved" && status !== "rejected" && status !== "pending")
        return reply.code(400).send({ error: "Invalid status" });
      if (id === req.user!.id) return reply.code(400).send({ error: "You can't change your own status" });
      const res = db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(status, id);
      if (res.changes === 0) return reply.code(404).send({ error: "User not found" });
      // Kick out sessions of users who are rejected.
      if (status === "rejected") db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
      return { ok: true };
    },
  );

  // No email means no "forgot password" flow, so an admin can set a new one.
  app.post<{ Params: { id: string }; Body: { password?: string } }>(
    "/api/admin/users/:id/password",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id);
      const password = String(req.body?.password ?? "");
      if (password.length < 8) return reply.code(400).send({ error: "Password must be at least 8 characters" });
      const res = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(await hashPassword(password), id);
      if (res.changes === 0) return reply.code(404).send({ error: "User not found" });
      db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id); // sign them out everywhere
      return { ok: true };
    },
  );
}

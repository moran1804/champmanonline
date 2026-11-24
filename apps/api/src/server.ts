import fs from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { config } from "./config.ts";
import { authRoutes, ensureAdmin } from "./auth.ts";
import { adminRoutes } from "./admin.ts";
import { gameRoutes } from "./games.ts";
import { seatRoutes } from "./seats.ts";
import { saveRoutes } from "./saves.ts";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  // Behind Cloudflare Tunnel: trust X-Forwarded-* so rate limiting sees the real client IP.
  trustProxy: true,
});

await app.register(cookie);
await app.register(rateLimit, {
  global: false,
  keyGenerator: (req) => (req.headers["cf-connecting-ip"] as string | undefined) ?? req.ip,
});

app.addHook("onSend", async (_req, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "SAMEORIGIN");
  reply.header("Referrer-Policy", "same-origin");
});

app.get("/api/health", async () => ({ ok: true }));

// Not app.register(): the session hook must apply to every route, not just inside an encapsulated plugin.
await authRoutes(app);
await app.register(adminRoutes);
await app.register(gameRoutes);
await app.register(saveRoutes);
await app.register(seatRoutes);

if (fs.existsSync(config.webDir)) {
  await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
  // Single-page app: unknown non-API paths get index.html so client-side routing works.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Not found" });
  });
} else {
  app.log.warn(`Web build not found at ${config.webDir}; only the API is served.`);
}

await ensureAdmin(app.log);
app.log.info(`Games root: ${config.gamesRoot}`);
app.log.info(`Data dir: ${config.dataDir}`);

await app.listen({ port: config.port, host: config.host });

// On "docker stop" (e.g. an app update), close cleanly so running Windows-game sessions are saved
// into their slots before the seats go away.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info(`${signal}: saving sessions and shutting down`);
    const force = setTimeout(() => process.exit(1), 50_000);
    force.unref();
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

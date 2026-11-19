import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, "app.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

const migrations: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     email TEXT NOT NULL UNIQUE COLLATE NOCASE,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE saves (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     game_id TEXT NOT NULL,
     slot INTEGER NOT NULL,
     label TEXT NOT NULL DEFAULT '',
     size INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE (user_id, game_id, slot)
   );`,
  // v2: email becomes optional (sign-up is just a username and password).
  `CREATE TABLE users_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     email TEXT UNIQUE COLLATE NOCASE,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
     created_at INTEGER NOT NULL
   );
   INSERT INTO users_new SELECT id, email, username, password_hash, role, status, created_at FROM users;
   DROP TABLE users;
   ALTER TABLE users_new RENAME TO users;`,
];

const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
// Foreign keys are off while migrating, so rebuilding a table can't cascade-delete sessions or saves.
if (current < migrations.length) db.exec("PRAGMA foreign_keys = OFF");
for (let v = current; v < migrations.length; v++) {
  db.exec("BEGIN");
  try {
    db.exec(migrations[v]!);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
db.exec("PRAGMA foreign_keys = ON");
{
  const problems = db.prepare("PRAGMA foreign_key_check").all();
  if (problems.length) throw new Error(`Database foreign key check failed: ${JSON.stringify(problems)}`);
}

export type User = {
  id: number;
  email: string | null;
  username: string;
  password_hash: string;
  role: "user" | "admin";
  status: "pending" | "approved" | "rejected";
  created_at: number;
};

export type PublicUser = Omit<User, "password_hash">;

export function toPublic(u: User): PublicUser {
  const { password_hash: _ignored, ...rest } = u;
  return rest;
}

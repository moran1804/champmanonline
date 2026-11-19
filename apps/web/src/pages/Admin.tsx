import { useCallback, useEffect, useState } from "react";
import { api, type User } from "../api";
import { useAuth } from "../auth";

export function AdminPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await api.admin.users()).users);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(id: number, status: User["status"]) {
    try {
      await api.admin.setStatus(id, status);
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!users) return <p className="muted">{error ?? "Loading…"}</p>;
  const pending = users.filter((u) => u.status === "pending").length;

  return (
    <>
      <h1>Players</h1>
      <p className="muted">
        {users.length} player{users.length === 1 ? "" : "s"}
        {pending > 0 && ` · ${pending} waiting for approval`}
      </p>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap card">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Joined</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.username} {u.role === "admin" && <span className="pill">admin</span>}
                </td>
                <td className="muted">{u.email ?? "–"}</td>
                <td>{new Date(u.created_at).toLocaleDateString("en-GB")}</td>
                <td>
                  <span className={`pill ${u.status}`}>{u.status}</span>
                </td>
                <td className="row-actions">
                  {u.id !== me?.id && (
                    <>
                      <button
                        className="btn ghost small"
                        onClick={async () => {
                          const pw = window.prompt(`New password for ${u.username} (at least 8 characters)`);
                          if (!pw) return;
                          try {
                            await api.admin.resetPassword(u.id, pw);
                            window.alert(`Password changed. Tell ${u.username} their new password.`);
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        Reset password
                      </button>
                      {u.status !== "approved" && (
                        <button className="btn primary small" onClick={() => setStatus(u.id, "approved")}>
                          Approve
                        </button>
                      )}
                      {u.status !== "rejected" && (
                        <button className="btn danger small" onClick={() => setStatus(u.id, "rejected")}>
                          {u.status === "pending" ? "Reject" : "Disable"}
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

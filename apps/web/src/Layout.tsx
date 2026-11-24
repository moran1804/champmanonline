import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "./auth";

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden width="26" height="26" />
          <span>
            RetroPC<strong>Games</strong>
          </span>
        </Link>
        <nav>
          {user ? (
            <>
              <NavLink to="/">Games</NavLink>
              {user.role === "admin" && <NavLink to="/admin">Admin</NavLink>}
              <span className="muted user-name">{user.username}</span>
              <button
                className="btn ghost small"
                onClick={async () => {
                  await logout();
                  navigate("/login");
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <NavLink to="/login">Sign in</NavLink>
              <NavLink to="/register">Register</NavLink>
            </>
          )}
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

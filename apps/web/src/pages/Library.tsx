import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type GameSummary } from "../api";
import { useAuth } from "../auth";

export function LibraryPage() {
  const { user } = useAuth();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const approved = user?.status === "approved";

  useEffect(() => {
    if (!approved) return;
    api
      .games()
      .then((r) => setGames(r.games))
      .catch((e) => setError((e as Error).message));
  }, [approved]);

  if (!approved) {
    return (
      <div className="card notice">
        <h1>Awaiting approval</h1>
        <p>
          Thanks for signing up, <strong>{user?.username}</strong>. An admin needs to approve your account before you
          can play. Check back soon.
        </p>
      </div>
    );
  }

  if (error) return <p className="error">{error}</p>;
  if (!games) return <p className="muted">Loading games…</p>;

  return (
    <>
      <h1>The dugout</h1>
      <p className="muted">Choose a season. Your careers are saved to your account so you can carry on from any computer.</p>
      <div className="game-grid">
        {games.map((g) => {
          const tile = (
            <>
              <div className="cover">
                {g.hasCover ? (
                  <img src={`/api/games/${g.id}/cover`} alt="" loading="lazy" />
                ) : (
                  <div className="cover-placeholder">{g.title}</div>
                )}
                {!g.playable && <span className="badge">{g.unavailable ? "Not available" : "Coming soon"}</span>}
              </div>
              <div className="tile-body">
                <strong>{g.title}</strong>
                <span className="muted small">
                  {g.year} · {g.platform === "dos" ? "DOS" : "Windows"}
                </span>
                {g.unavailable && <span className="muted small">{g.unavailable}</span>}
              </div>
            </>
          );
          return g.playable ? (
            <Link key={g.id} to={`/games/${g.id}`} className="game-tile">
              {tile}
            </Link>
          ) : (
            <div key={g.id} className="game-tile disabled" aria-disabled>
              {tile}
            </div>
          );
        })}
      </div>
    </>
  );
}

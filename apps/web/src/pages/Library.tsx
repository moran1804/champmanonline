import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type GameSummary } from "../api";
import { useAuth } from "../auth";

/** Homepage groups, in display order. Games with an unknown category go in "Other". */
const CATEGORIES = [
  { id: "championship-manager", label: "Championship Manager" },
  { id: "point-and-click", label: "Point & Click Adventures" },
  { id: "shoot-em-up", label: "Shoot 'em Ups" },
  { id: "strategy-sim", label: "Strategy & Simulation" },
  { id: "platform-action", label: "Platform & Action" },
  { id: "puzzle", label: "Puzzle" },
  { id: "educational", label: "Educational" },
  { id: "other", label: "Other" },
  { id: "adult", label: "18+" },
];
const ADULT_KEY = "cmo-adult-ok";

export function LibraryPage() {
  const { user } = useAuth();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adultOk, setAdultOk] = useState(() => {
    try {
      return localStorage.getItem(ADULT_KEY) === "1";
    } catch {
      return false;
    }
  });

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

  function tile(g: GameSummary) {
    const body = (
      <>
        <div className="cover">
          {g.hasCover ? (
            <img src={`/api/games/${g.id}/cover`} alt="" loading="lazy" />
          ) : (
            <div className="cover-placeholder">{g.title}</div>
          )}
          {!g.playable && <span className="badge">{g.unavailable ? "Not available" : "Coming soon"}</span>}
          {g.category === "adult" && <span className="badge adult">18+</span>}
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
        {body}
      </Link>
    ) : (
      <div key={g.id} className="game-tile disabled" aria-disabled>
        {body}
      </div>
    );
  }

  function confirmAdult() {
    setAdultOk(true);
    try {
      localStorage.setItem(ADULT_KEY, "1");
    } catch {
      // Not remembered; still shown for this visit.
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!games) return <p className="muted">Loading games…</p>;

  const q = query.trim().toLowerCase();
  const visible = games.filter((g) => !q || g.title.toLowerCase().includes(q) || String(g.year).includes(q));
  const groups = CATEGORIES.map((c) => ({
    ...c,
    games: visible
      .filter((g) => (CATEGORIES.some((k) => k.id === g.category) ? g.category : "other") === c.id)
      .sort((a, b) => Number(b.playable) - Number(a.playable) || a.year - b.year || a.title.localeCompare(b.title)),
  })).filter((c) => c.games.length > 0);

  return (
    <>
      <div className="library-head">
        <div>
          <h1>Game library</h1>
          <p className="muted">Pick a game. Your saves are stored with your account, so you can carry on from any computer.</p>
        </div>
        <input
          className="library-search"
          type="search"
          placeholder="Search games…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search games"
        />
      </div>

      <nav className="category-nav" aria-label="Categories">
        {groups.map((c) => (
          <a key={c.id} href={`#${c.id}`}>
            {c.label}
          </a>
        ))}
      </nav>

      {groups.length === 0 && <p className="muted">No games match “{query}”.</p>}

      {groups.map((c) => (
        <section key={c.id} id={c.id} className="category">
          <h2>
            {c.label} <span className="muted small">{c.games.length}</span>
          </h2>
          {c.id === "adult" && !adultOk ? (
            <div className="card adult-gate">
              <p>These games have adult themes and nudity.</p>
              <button className="btn" onClick={confirmAdult}>
                I'm 18 or over, show them
              </button>
            </div>
          ) : (
            <div className="game-grid">{c.games.map(tile)}</div>
          )}
        </section>
      ))}
    </>
  );
}

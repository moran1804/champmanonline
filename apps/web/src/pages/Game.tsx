import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type GameDetail, type SaveSlot } from "../api";

function formatWhen(ts: number) {
  return new Date(ts).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function GamePage() {
  const { gameId = "" } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState<GameDetail | null>(null);
  const [saves, setSaves] = useState<SaveSlot[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, s] = await Promise.all([api.game(gameId), api.saves(gameId)]);
      setGame(g.game);
      setSaves(s.saves);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [gameId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!game) return <p className="muted">Loading…</p>;

  const slots = Array.from({ length: game.maxSlots }, (_, i) => i + 1);

  return (
    <>
      <p>
        <Link to="/" className="muted small">
          ← All games
        </Link>
      </p>
      <div className="game-header">
        <img src={`/api/games/${game.id}/cover`} alt="" className="game-header-cover" />
        <div>
          <h1>{game.title}</h1>
          <p className="muted">
            Each slot is a separate saved game. Save inside the game as usual; the site then stores your save files with your
            account automatically.
          </p>
          {game.note && <p className="game-note">{game.note}</p>}
          {(game.hasLookup || game.hasManual) && (
            <p className="game-links">
              {game.hasLookup && <Link to={`/games/${game.id}/results`}>Manual results lookup</Link>}
              {game.hasManual && (
                <a href={`/api/games/${game.id}/manual`} target="_blank" rel="noreferrer">
                  Game manual (PDF) ↗
                </a>
              )}
            </p>
          )}
        </div>
      </div>

      <ul className="slot-list">
        {slots.map((slot) => {
          const save = saves.find((s) => s.slot === slot);
          return (
            <li key={slot} className="slot card">
              <div className="slot-info">
                <span className="slot-number">{slot}</span>
                {save ? (
                  <div>
                    <strong>{save.label || `Save ${slot}`}</strong>
                    <div className="muted small">Last saved {formatWhen(save.updatedAt)}</div>
                  </div>
                ) : (
                  <div className="muted">Empty slot</div>
                )}
              </div>
              <div className="slot-actions">
                {save ? (
                  <>
                    <button className="btn primary" onClick={() => navigate(`/play/${game.id}/${slot}`)}>
                      Continue
                    </button>
                    <button
                      className="btn ghost small"
                      onClick={async () => {
                        const label = window.prompt("Name this save", save.label || `Save ${slot}`);
                        if (label === null) return;
                        await api.renameSave(game.id, slot, label.trim());
                        void load();
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="btn danger small"
                      onClick={async () => {
                        if (!window.confirm(`Delete "${save.label || `Save ${slot}`}"? This can't be undone.`)) return;
                        await api.deleteSave(game.id, slot);
                        void load();
                      }}
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  <button className="btn" onClick={() => navigate(`/play/${game.id}/${slot}`)}>
                    New game
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="card tips">
        <h2>How saving works</h2>
        <ol>
          <li>Inside {game.title}, use the game's own save option as you normally would.</li>
          <li>
            The site checks for new save files regularly and uploads them. You can also press <em>Save to cloud</em>{" "}
            in the toolbar at any time.
          </li>
          <li>
            When you come back, press <em>Continue</em> here, then load your save inside the game.
          </li>
        </ol>
      </div>
    </>
  );
}

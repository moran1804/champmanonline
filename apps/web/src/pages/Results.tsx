import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type GameDetail } from "../api";
import { ResultsLookup } from "../components/ResultsLookup";

export function ResultsPage() {
  const { gameId = "" } = useParams();
  const [game, setGame] = useState<GameDetail | null>(null);

  useEffect(() => {
    api
      .game(gameId)
      .then((r) => setGame(r.game))
      .catch(() => {});
  }, [gameId]);

  return (
    <>
      <p>
        <Link to={`/games/${gameId}`} className="muted small">
          ← {game?.title ?? "Back"}
        </Link>
      </p>
      <h1>Manual results</h1>
      <p className="muted">
        When the game asks for a result from the manual, type the page number it mentions to see that page's results.
      </p>
      <div className="card">
        <ResultsLookup gameId={gameId} autoFocus />
      </div>
    </>
  );
}

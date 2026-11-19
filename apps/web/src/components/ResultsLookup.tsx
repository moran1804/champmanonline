import { useEffect, useMemo, useRef, useState } from "react";
import { api, type LookupTable } from "../api";

/**
 * Page-number lookup over the manual's results table: type the page the game asks about and the
 * match results for that page are shown large. Optionally shows the full table underneath.
 */
export function ResultsLookup({
  gameId,
  compact = false,
  autoFocus = false,
}: {
  gameId: string;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const [table, setTable] = useState<LookupTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(!compact);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .lookup(gameId)
      .then(setTable)
      .catch((e) => setError((e as Error).message));
  }, [gameId]);

  useEffect(() => {
    if (table && autoFocus) inputRef.current?.focus();
  }, [table, autoFocus]);

  // Compare ignoring case/punctuation and leading zeros; fall back to a prefix match so that e.g.
  // "1946" finds the season "1946-47", and "64/65" finds "1964-65".
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^0+(?=\d)/, "");
  const key = norm(query);
  const match = useMemo(() => {
    if (!table || key === "") return null;
    // Also match seasons written the short way, as the games ask ("64/65" or "64" for 1964-65).
    const short = (v: string) => norm(v).replace(/^(19|20)(?=\d{4})/, "");
    return (
      table.rows.find((r) => norm(r[0] ?? "") === key) ??
      table.rows.find((r) => short(r[0] ?? "") === key) ??
      table.rows.find((r) => norm(r[0] ?? "").startsWith(key)) ??
      table.rows.find((r) => short(r[0] ?? "").startsWith(key)) ??
      null
    );
  }, [table, key]);
  const numericKeys = table?.rows.every((r) => /^\d+$/.test((r[0] ?? "").trim())) ?? true;

  if (error) return <p className="muted">{error}</p>;
  if (!table) return <p className="muted">Loading results…</p>;

  const [firstHeader = "Page", ...resultHeaders] = table.headers;

  return (
    <div className={`lookup ${compact ? "compact" : ""}`}>
      <label className="lookup-input">
        <span>{numericKeys ? `${firstHeader} number` : firstHeader}</span>
        <input
          ref={inputRef}
          inputMode={numericKeys ? "numeric" : "text"}
          value={query}
          onChange={(e) => setQuery(e.target.value.slice(0, 12))}
          placeholder={`e.g. ${table.rows[Math.min(11, table.rows.length - 1)]?.[0] ?? ""}`}
          aria-label={firstHeader}
          className={numericKeys ? undefined : "wide"}
        />
      </label>

      {key !== "" &&
        (match ? (
          <div className="lookup-result" aria-live="polite">
            {resultHeaders.map((h, i) => (
              <div key={h} className="lookup-cell">
                <span className="muted small">{h}</span>
                <strong>{match[i + 1] || "–"}</strong>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted small" aria-live="polite">
            {firstHeader} {query.trim()} isn't in the table.
          </p>
        ))}

      {compact && (
        <button className="btn ghost small" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Hide full table" : "Show full table"}
        </button>
      )}

      {showAll && (
        <div className="lookup-table-wrap">
          <table className="lookup-table">
            <thead>
              <tr>
                {table.headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                <tr key={r[0]} className={match === r ? "hit" : undefined}>
                  {r.map((c, i) => (i === 0 ? <th key={i}>{c}</th> : <td key={i}>{c}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Reads a game's "manual lookup" table (e.g. the page → match results the game asks for at start-up)
// from a file in the version folder whose name contains "results": .rtf (table), .csv or .txt (tab/comma).
import fs from "node:fs";
import path from "node:path";

export type LookupTable = { headers: string[]; rows: string[][] };

const cache = new Map<string, { mtimeMs: number; table: LookupTable }>();

export function findLookupFile(versionDir: string): string | null {
  try {
    const f = fs
      .readdirSync(versionDir)
      .find((n) => /results.*\.(rtf|csv|txt)$/i.test(n) && !n.startsWith("._"));
    return f ? path.join(versionDir, f) : null;
  } catch {
    return null;
  }
}

export function readLookup(file: string): LookupTable {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.table;
  const text = fs.readFileSync(file, "latin1");
  const lower = file.toLowerCase();
  let table: LookupTable;
  if (lower.endsWith(".rtf")) {
    // A real RTF table, or else a plain-text table that was saved as RTF (e.g. by TextEdit).
    table = parseRtfTable(text);
    if (table.rows.length === 0) table = parseDelimited(rtfToText(text), false);
  } else {
    table = parseDelimited(text, lower.endsWith(".csv"));
  }
  cache.set(file, { mtimeMs: st.mtimeMs, table });
  return table;
}

function decodeRtfText(s: string): string {
  return s
    .replace(/\\'([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n: string) => String.fromCharCode((Number(n) + 65536) % 65536))
    .replace(/\\[a-z]+-?\d* ?/gi, "") // control words like \f1\b0 \cf2
    .replace(/\\([\\{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Converts RTF to plain text, keeping line breaks and tabs. */
export function rtfToText(rtf: string): string {
  return rtf
    .replace(/\{\\\*[^{}]*\}/g, "")
    .replace(/\{\\fonttbl[^]*?\}\s*\}/, "")
    .replace(/\{\\colortbl[^{}]*\}/, "")
    .replace(/\\\r?\n/g, "\n") // macOS RTF line break: backslash + newline
    .replace(/\\(par|line)\b ?/g, "\n")
    .replace(/\\tab\b ?/g, "\t")
    .replace(/\\'([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/\\([\\{}])/g, "$1")
    .replace(/[{}]/g, "");
}

/** Extracts the cells of every table row (\row) in an RTF document. */
export function parseRtfTable(rtf: string): LookupTable {
  // Drop destination groups such as {\*\expandedcolortbl ...}, font and colour tables.
  const body = rtf
    .replace(/\{\\\*[^{}]*\}/g, "")
    .replace(/\{\\fonttbl[^]*?\}\s*\}/, "")
    .replace(/\{\\colortbl[^{}]*\}/, "");
  const rows: string[][] = [];
  for (const rowText of body.split(/\\row\b/)) {
    const parts = rowText.split(/\\cell\b/);
    parts.pop(); // text after the last \cell isn't a cell
    if (parts.length === 0) continue;
    // Each cell's text follows the last paragraph/row definition (\pard / \trowd ... ) in its segment.
    const cells = parts.map((p) => decodeRtfText(p.split(/\\pard\b/).pop() ?? ""));
    if (cells.some((c) => c !== "")) rows.push(cells);
  }
  const [headers = [], ...data] = rows;
  return { headers, rows: data };
}

/**
 * Plain-text tables: CSV, tab-separated, or columns aligned with spaces (2+ spaces between cells).
 * Prose lines around the table are ignored by keeping only rows with the most common column count.
 */
function parseDelimited(text: string, csv: boolean): LookupTable {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => (csv ? l.split(",") : l.split(/\s*\t\s*|\s{2,}/)).map((c) => c.trim()));
  const counts = new Map<number, number>();
  for (const r of rows) if (r.length >= 2) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
  const width = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const [headers = [], ...data] = rows.filter((r) => r.length === width);
  return { headers, rows: data };
}

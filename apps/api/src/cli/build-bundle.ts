// Usage: npm run build:bundle [gameId...]
// Pre-builds the .jsdos bundle(s) into DATA_DIR/cache/bundles. The server also builds them on demand.
import fs from "node:fs";
import { ensureBundle, isPlayable, loadCatalog } from "../games.ts";

const ids = process.argv.slice(2);
const games = loadCatalog().filter((g) => (ids.length ? ids.includes(g.id) : isPlayable(g)));
if (games.length === 0) {
  console.error("No matching playable games.");
  process.exit(1);
}
for (const g of games) {
  if (!isPlayable(g)) {
    console.error(`${g.id}: not playable (disabled, no dosbox config, or files missing)`);
    continue;
  }
  const { file, version } = await ensureBundle(g);
  console.log(`${g.id}: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB, v=${version})`);
}

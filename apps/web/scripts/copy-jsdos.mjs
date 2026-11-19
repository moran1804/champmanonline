// Copies the js-dos player and emulator (wasm) files into public/jsdos so they are self-hosted
// rather than loaded from the js-dos CDN.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");

let dir = webRoot;
let src = null;
while (true) {
  const candidate = path.join(dir, "node_modules", "js-dos", "dist");
  if (fs.existsSync(candidate)) {
    src = candidate;
    break;
  }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
if (!src) {
  console.error("js-dos not found in node_modules; run npm install first.");
  process.exit(1);
}

const dest = path.join(webRoot, "public", "jsdos");
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, {
  recursive: true,
  // Source maps, symbol files and debug builds aren't needed at runtime.
  filter: (p) => !/\.(map|symbols)$/.test(p) && !/-dbg\./.test(p) && !p.includes(`${path.sep}types`),
});
console.log(`Copied js-dos from ${src} to ${dest}`);

#!/usr/bin/env node
/*
 * Renders extension/icons/extension-icon.svg into PNGs at the sizes the
 * Chrome Web Store + manifest's icons / action.default_icon fields ask
 * for. Drop new sizes into the SIZES array if needed.
 *
 * Run: npm run build:icons   (defined in package.json)
 *
 * `sharp` is a devDependency — installed lazily; if you cloned the repo
 * fresh, run `npm install` first. The generated PNGs are checked into
 * the repo so end-users (and the Chrome Web Store) don't need to run
 * this script.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// fileURLToPath handles Windows drive prefixes correctly;
// new URL(import.meta.url).pathname leaks a leading slash on Win32.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SRC = path.join(REPO_ROOT, "extension", "icons", "extension-icon.svg");
const OUT_DIR = path.join(REPO_ROOT, "extension", "icons");

// Action toolbar: 16/24/32. Manifest icons (also used by chrome://
// extensions tile + Web Store listing): 16/32/48/128.
const SIZES = [16, 24, 32, 48, 128];

async function main() {
  const svgRaw = await fs.readFile(SRC, "utf8");
  // The supplied SVG declares viewBox="0 0 32 32" but the actual
  // artwork bounds are roughly (2,2)-(30,30). Tightening the viewBox
  // at render time crops the whitespace and gives the toolbar icon
  // more presence.
  //
  // "3 3 26 26" is ~23% zoom — the maximum we can pull in before the
  // magnifier-handle path (which extends to y=30 in the source) starts
  // to clip the visible region. Tighter crops trade artwork
  // completeness for size; this is the floor that keeps the whole icon
  // visible at every output size. Source SVG file stays unchanged so
  // a future re-import from svgrepo overwrites cleanly.
  const svgBuf = Buffer.from(
    svgRaw.replace(/viewBox="0 0 32 32"/, 'viewBox="3 3 26 26"'),
    "utf8",
  );
  for (const size of SIZES) {
    const outPath = path.join(OUT_DIR, `icon-${size}.png`);
    await sharp(svgBuf, { density: Math.max(72, size * 4) })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(outPath);
    console.log(`wrote ${path.relative(REPO_ROOT, outPath)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

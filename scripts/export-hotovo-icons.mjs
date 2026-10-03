// Renders the Hotovo Peer icons from assets/hotovo/*.svg into the paths the
// desktop build and the web favicons read (assets/prod). Run from the repo root:
//   node scripts/export-hotovo-icons.mjs
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "apps/desktop/package.json"));
let sharp;
try {
  sharp = require("sharp");
} catch {
  const pnpmDir = path.join(root, "node_modules/.pnpm");
  const { readdirSync } = await import("node:fs");
  const entry = readdirSync(pnpmDir).find((name) => name.startsWith("sharp@"));
  sharp = (await import(path.join(pnpmDir, entry, "node_modules/sharp/dist/index.mjs"))).default;
}

const macSvg = await readFile(path.join(root, "assets/hotovo/icon-macos.svg"));
const fullSvg = await readFile(path.join(root, "assets/hotovo/icon-full.svg"));
const png = (svg, size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

const outputs = [
  ["assets/prod/black-macos-1024.png", macSvg, 1024],
  ["assets/prod/black-universal-1024.png", fullSvg, 1024],
  ["assets/prod/black-ios-1024.png", fullSvg, 1024],
  ["assets/prod/t3-black-web-apple-touch-180.png", fullSvg, 180],
  ["assets/prod/t3-black-web-favicon-32x32.png", fullSvg, 32],
  ["assets/prod/t3-black-web-favicon-16x16.png", fullSvg, 16],
];
for (const [file, svg, size] of outputs) {
  await writeFile(path.join(root, file), await png(svg, size));
  console.log(`wrote ${file}`);
}

// An .ico is a small directory of embedded PNGs.
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map((size) => png(fullSvg, size)));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const entry = 6 + 16 * i;
  header.writeUInt8(size, entry);
  header.writeUInt8(size, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
});
await writeFile(
  path.join(root, "assets/prod/t3-black-web-favicon.ico"),
  Buffer.concat([header, ...images]),
);
console.log("wrote assets/prod/t3-black-web-favicon.ico");

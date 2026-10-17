#!/usr/bin/env node
/** Optimize the learning gallery's browser captures; see widget-examples/README.md. */
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/pack-widget-examples.mjs <capture-directory>");
const source = await readFile(path.join(root, "lib/streamStudioLearn.ts"), "utf8");
const catalog = source.slice(source.indexOf("export const WIDGET_GUIDES"));
const ids = [...catalog.matchAll(/id: "([a-z-]+)", name:/g)].map((match) => match[1]);
if (ids.length !== 31 || new Set(ids).size !== ids.length) throw new Error("Review the widget catalog before exporting.");
const output = path.join(root, "public/images/widget-examples");
await mkdir(output, { recursive: true });
let bytes = 0;
for (const id of ids) {
  const image = sharp(path.resolve(input, `${id}.jpg`));
  const meta = await image.metadata();
  if (meta.width !== 1400 || meta.height !== 900) throw new Error(`${id}: expected a 1400 x 900 capture`);
  const target = path.join(output, `${id}.webp`);
  await image.webp({ quality: 90, effort: 6 }).toFile(target);
  bytes += (await stat(target)).size;
}
console.log(`Packed ${ids.length} widget examples (${Math.round(bytes / 1024)} KiB) into ${output}`);

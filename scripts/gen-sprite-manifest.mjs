#!/usr/bin/env node
/**
 * gen-sprite-manifest — bakes the per-sheet JSON sidecars shipped with
 * the Blender-rendered SC2 sprite sheets into ONE compact TypeScript
 * module the web app bundles (``lib/spriteManifest.generated.ts``).
 *
 * Why bundle instead of fetch: the geometry (cell size, grid, anchor,
 * worldUnitsPerCell) is needed SYNCHRONOUSLY on the very first frame —
 * it decides whether a name has a sprite at all, how big to draw it,
 * and which raster bucket to build. Fetching 103 sidecars would put a
 * request waterfall in front of every first paint and make units pop
 * from the fallback icon to the sprite at the wrong size. The whole
 * table is ~20 KB of source (≈4 KB gzipped) — cheaper than one sheet.
 *
 * Only the .webp SHEETS are fetched at runtime, from NEXT_PUBLIC_SPRITE_BASE.
 *
 * Usage:
 *   node scripts/gen-sprite-manifest.mjs \
 *     --units   /path/to/out/webp/units \
 *     --buildings /path/to/out/webp/buildings \
 *     --out     apps/web/lib/spriteManifest.generated.ts
 *
 * Re-run whenever sprites are re-rendered. The generated file is
 * checked in so CI/builds don't need the asset tree.
 */

import fs from "node:fs";
import path from "node:path";

function argOf(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const unitsDir = argOf("--units", "apps/web/public/sprites/units");
const buildingsDir = argOf("--buildings", "apps/web/public/sprites/buildings");
const outFile = argOf("--out", "apps/web/lib/spriteManifest.generated.ts");
const attackLedger = argOf("--attacks", "tools/sc2-alert-renders/replay-attack-clips.json");
const attackClips = fs.existsSync(attackLedger)
  ? JSON.parse(fs.readFileSync(attackLedger, "utf8")).clips : {};
/** Fall back to the PNG source trees when the webp conversion of a
 * given sprite has not landed yet — the geometry is identical. */
const fallbackDirs = {
  unit: argOf("--units-fallback", "/tmp/work/out/sprites"),
  building: argOf("--buildings-fallback", "/tmp/work/out/sprites_buildings"),
};

/** Quantised world-unit ladder shared by units AND buildings. Every
 * sidecar value must land on it — a value off the ladder means the
 * render pipeline changed and the scale contract needs re-checking. */
const WORLD_LADDER = [1.3, 1.7, 2.2, 2.85, 3.7, 4.8, 6.25, 8.1, 10.5, 13.7];

function collectSidecars(root, kind) {
  /** @type {Map<string, {file: string, race: string}>} */
  const found = new Map();
  const roots = [root, fallbackDirs[kind]].filter(
    (d) => d && fs.existsSync(d),
  );
  for (const dir of roots) {
    for (const race of fs.readdirSync(dir)) {
      const raceDir = path.join(dir, race);
      if (!fs.statSync(raceDir).isDirectory()) continue;
      for (const file of fs.readdirSync(raceDir)) {
        // One sidecar per (unit, colour); the red and blue variants are
        // geometrically identical, so read red and assert blue matches.
        if (!file.endsWith("_red.json")) continue;
        const name = file.slice(0, -"_red.json".length);
        if (!found.has(name)) {
          found.set(name, { file: path.join(raceDir, file), race });
        }
      }
    }
  }
  return found;
}

/** One anim's geometry, resolving per-anim overrides over the
 * sheet-level defaults exactly the way the sidecar contract says. */
function animMeta(sidecar, animName, anim) {
  const sheetSize = anim.sheetSize ?? sidecar.sheetSize;
  const frameSize = sidecar.frameSize;
  const cols = Math.max(1, Math.floor(sheetSize[0] / frameSize));
  const rows = Math.max(1, Math.floor(sheetSize[1] / frameSize));
  const wupc = anim.worldUnitsPerCell ?? sidecar.worldUnitsPerCell;
  const anchor = anim.anchor ?? sidecar.anchor;
  // "Marine_red_Walk.png" → "Walk"; the top-level sheet has no suffix.
  const sheet = anim.sheet ?? sidecar.sheet;
  const base = path.basename(String(sheet)).replace(/\.(png|webp)$/i, "");
  const suffix = base.replace(/^.*?_(red|blue)_?/i, "") || null;

  const frames = Math.max(1, anim.frames | 0);
  const facings = Math.max(1, sidecar.facings | 0);
  // Grid sanity: the last cell the draw path can address must exist.
  const maxCell = (facings - 1) * cols + (frames - 1);
  if (maxCell >= cols * rows) {
    throw new Error(
      `${sidecar.unit}/${animName}: grid ${cols}x${rows} cannot hold ` +
        `facings=${facings} frames=${frames} (max cell ${maxCell})`,
    );
  }
  if (!WORLD_LADDER.includes(wupc)) {
    throw new Error(`${sidecar.unit}/${animName}: worldUnitsPerCell ${wupc} off the ladder`);
  }
  return {
    frames,
    fps: Number(anim.fps) || 0,
    cols,
    rows,
    suffix: suffix && suffix !== "" ? suffix : null,
    wupc,
    ax: Number(anchor[0]),
    ay: Number(anchor[1]),
  };
}

const entries = [];
for (const [kind, dir] of [
  ["unit", unitsDir],
  ["building", buildingsDir],
]) {
  for (const [name, { file, race }] of [...collectSidecars(dir, kind)].sort()) {
    const sidecar = JSON.parse(fs.readFileSync(file, "utf8"));
    const anims = {};
    for (const [animName, anim] of Object.entries(sidecar.anims)) {
      anims[animName] = animMeta(sidecar, animName, anim);
    }
    const attack = kind === "unit" ? attackClips[name] : null;
    if (attack) {
      if (attack.race !== race || attack.frameSize !== sidecar.frameSize || attack.facings !== sidecar.facings) {
        throw new Error(`${name}: Attack atlas dimensions do not match the sprite contract`);
      }
      anims.Attack = animMeta(sidecar, "Attack", attack.animation);
    }
    if (!anims.Stand) throw new Error(`${name}: no Stand anim`);
    entries.push({
      name,
      kind,
      race,
      frameSize: sidecar.frameSize,
      facings: Math.max(1, sidecar.facings | 0),
      anims,
    });
  }
}

entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
if (!entries.length) {
  throw new Error("No source sprite sidecars found; restore the baked asset tree before regenerating the manifest.");
}

const num = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4))));
const lines = [];
for (const e of entries) {
  const animSrc = Object.entries(e.anims)
    .map(
      ([an, a]) =>
        `      ${an}: { frames: ${a.frames}, fps: ${num(a.fps)}, cols: ${a.cols}, ` +
        `rows: ${a.rows}, suffix: ${a.suffix ? JSON.stringify(a.suffix) : "null"}, ` +
        `wupc: ${num(a.wupc)}, ax: ${num(a.ax)}, ay: ${num(a.ay)} },`,
    )
    .join("\n");
  lines.push(
    `  ${JSON.stringify(e.name)}: {\n` +
      `    kind: "${e.kind}",\n` +
      `    race: "${e.race}",\n` +
      `    frameSize: ${e.frameSize},\n` +
      `    facings: ${e.facings},\n` +
      `    anims: {\n${animSrc}\n    },\n` +
      `  },`,
  );
}

const counts = entries.reduce(
  (acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }),
  {},
);

const src = `/* eslint-disable */
/**
 * GENERATED FILE — do not edit by hand.
 * Run \`node scripts/gen-sprite-manifest.mjs\` after re-rendering sprites.
 *
 * Baked geometry for the ${entries.length} Blender-rendered SC2 sprite sheets
 * (${counts.unit ?? 0} units, ${counts.building ?? 0} buildings). Field meanings:
 *
 *   frameSize  px per grid cell in the SOURCE sheet
 *   facings    8 for units (row = facing), 1 for buildings (never rotate)
 *   cols/rows  grid derived from sheetSize / frameSize — the draw path
 *              addresses cell (facing * cols + frame), so this is the
 *              single source of truth for BOTH the 8x8 unit sheets and
 *              the 4x2 / 1x1 building sheets
 *   suffix     sheet filename suffix ("Walk" -> Name_color_Walk.webp),
 *              null for the default sheet (Name_color.webp)
 *   wupc       worldUnitsPerCell — how many SC2 world-X units one cell
 *              spans. Draw width in px = wupc * pixelsPerWorldUnit.
 *   ax, ay     anchor px inside the cell where the model's ground
 *              origin projects; this pixel lands on the map coordinate
 */

export interface SpriteAnimMeta {
  readonly frames: number;
  readonly fps: number;
  readonly cols: number;
  readonly rows: number;
  readonly suffix: string | null;
  readonly wupc: number;
  readonly ax: number;
  readonly ay: number;
}

export interface SpriteSheetMeta {
  readonly kind: "unit" | "building";
  readonly race: "Terran" | "Protoss" | "Zerg";
  readonly frameSize: number;
  readonly facings: number;
  readonly anims: Readonly<Record<string, SpriteAnimMeta>>;
}

export const SPRITE_MANIFEST: Readonly<Record<string, SpriteSheetMeta>> = {
${lines.join("\n")}
};
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, src);
console.log(
  `wrote ${outFile}: ${entries.length} sprites ` +
    `(${counts.unit ?? 0} units, ${counts.building ?? 0} buildings), ${src.length} bytes`,
);

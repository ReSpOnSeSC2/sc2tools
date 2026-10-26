import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TEXT_TOKENS = ["text", "text-muted", "text-dim", "accent-ink", "accent-ink-hover", "accent-cyan", "signal", "signal-hover", "editorial", "editorial-soft", "success", "warning", "danger", "player-you", "player-opp", "race-protoss", "race-terran", "race-zerg", "race-random"];
const SURFACES = ["bg", "bg-surface", "bg-elevated"];
const FILLS = ["accent", "accent-hover", "danger-fill"];
const BORDERS = ["border", "border-strong", "line"];

function tokens(block) {
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)].map(match => [match[1], match.slice(2).map(Number)]));
}

/** Test the actual declarations, including a dark replay inside a light page. */
export function contrastThemes(css) {
  const block = pattern => {
    const found = css.match(pattern);
    if (!found) throw new Error(`Missing theme block: ${pattern}`);
    return tokens(found[1]);
  };
  const dark = block(/:root\[data-theme="dark"\],[^{]*\{([\s\S]*?)\n\}/);
  const light = block(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);
  const replay = block(/\.replay-scope\s*\{([\s\S]*?)\n\}/);
  return { dark, light, "replay on light": { ...light, ...replay } };
}

export function contrastRatio(a, b) {
  const luminance = rgb => rgb.map(value => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}

/** One matrix supplies regression assertions and the contributor-doc table. */
export function contrastMatrix(css) {
  return Object.entries(contrastThemes(css)).flatMap(([theme, palette]) => {
    const rgb = name => {
      if (!palette[name]) throw new Error(`Missing ${theme} token ${name}`);
      return palette[name];
    };
    return [
      ...TEXT_TOKENS.flatMap(foreground => SURFACES.map(background => ({ theme, foreground, background, minimum: 4.5, ratio: contrastRatio(rgb(foreground), rgb(background)) }))),
      ...FILLS.map(background => ({ theme, foreground: "white", background, minimum: 4.5, ratio: contrastRatio([255, 255, 255], rgb(background)) })),
      ...BORDERS.flatMap(foreground => SURFACES.map(background => ({ theme, foreground, background, minimum: 3, ratio: contrastRatio(rgb(foreground), rgb(background)) }))),
    ];
  });
}

export function contrastTable(css) {
  const rows = contrastMatrix(css);
  const labels = [...TEXT_TOKENS, ...FILLS.map(fill => `white on ${fill}`), ...BORDERS];
  const themes = Object.keys(contrastThemes(css));
  return ["| Pair (worst of ground, surface and raised) | Dark | Light | Replay on light | Minimum |", "| --- | ---: | ---: | ---: | ---: |", ...labels.map(label => {
    const group = rows.filter(row => (row.foreground === "white" ? `white on ${row.background}` : row.foreground) === label);
    return `| ${label} | ${themes.map(theme => Math.min(...group.filter(row => row.theme === theme).map(row => row.ratio)).toFixed(2) + ":1").join(" | ")} | ${group[0].minimum}:1 |`;
  })].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  process.stdout.write(contrastTable(css) + "\n");
}

import { wrRamp } from "./format";
export type MatrixRace = "all" | "P" | "T" | "Z";
export type MatrixRow = { my_build: string; opp_strat: string; total: number; myMatchups?: Partial<Record<Exclude<MatrixRace, "all">, number>> };

export function defaultMatrixRace(rows: readonly MatrixRow[] = []): MatrixRace {
  const counts = (["P", "T", "Z"] as const).map(race => ({ race, n: rows.reduce((sum, row) => {
    const n = row.myMatchups?.[race]; return sum + (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
  }, 0) }));
  const max = Math.max(...counts.map(row => row.n));
  return max > 0 && counts.filter(row => row.n === max).length === 1 ? counts.find(row => row.n === max)!.race : "all";
}
export function matrixAxes(rows: readonly MatrixRow[], order: "games" | "az") {
  const totals = (key: "my_build" | "opp_strat") => {
    const result = new Map<string, number>();
    for (const row of rows) result.set(row[key], (result.get(row[key]) || 0) + row.total);
    return [...result].filter(([, n]) => n > 0).sort((a, b) => (order === "games" ? b[1] - a[1] : 0) || a[0].localeCompare(b[0], "en")).map(([name]) => name);
  };
  return { builds: totals("my_build"), strategies: totals("opp_strat") };
}
export const matrixCellKey = (build: string, strategy: string) => JSON.stringify([build, strategy]);
type Rgb = readonly [number, number, number];
const luminance = (rgb: Rgb) => rgb.map(value => { const x = value / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
export const colorContrast = (a: Rgb, b: Rgb) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };

/** Encode sample size in the background only; retain readable, opaque labels. */
export function matrixCellStyle(rate: number, games: number, minGames: number, surface: Rgb, ramp = wrRamp) {
  const rgb = Number.isFinite(rate) ? ramp(rate) : [154, 163, 178];
  const n = Number.isFinite(games) ? Math.max(0, games) : 0, floor = Number.isFinite(minGames) && minGames > 0 ? minGames : 1;
  const desired = Math.round((.35 + .65 * Math.min(1, n / (floor * 5))) * 1000) / 1000;
  const candidates = [desired, ...Array.from({ length: 66 }, (_, i) => Math.min(1, Math.round((desired + (i + 1) * .01) * 1000) / 1000)),
    ...Array.from({ length: 66 }, (_, i) => Math.max(.35, Math.round((desired - (i + 1) * .01) * 1000) / 1000))];
  let alpha = desired, color = "#0c0c0c", contrast = 0;
  for (const candidate of candidates) {
    alpha = candidate;
    const composite = rgb.map((x, i) => x * alpha + surface[i] * (1 - alpha)) as [number, number, number];
    const dark = colorContrast(composite, [12, 12, 12]), light = colorContrast(composite, [255, 255, 255]);
    color = dark >= light ? "#0c0c0c" : "#ffffff"; contrast = Math.max(dark, light);
    if (contrast >= 4.55) break;
  }
  return { backgroundColor: `rgb(${rgb.join(" ")} / ${alpha.toFixed(3)})`, color, alpha, contrast };
}

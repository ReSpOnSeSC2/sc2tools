export type StrengthFields = {
  ratedGames?: number;
  ratedWins?: number;
  expectedWins?: number | null;
  winsAboveExpected?: number | null;
  perfRating?: number | null;
  excludedNoMmr?: number;
  excludedIneligible?: number;
  winRateRange?: { low: number; high: number } | null;
  expectation?: { method: "elo" | "calibrated"; eloScale: number; sampleGames: number; supportedBins: number };
};

export function signedWins(value: number): string {
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  return `${rounded === 0 ? "±" : value > 0 ? "+" : "−"}${rounded.toFixed(1)}`;
}

/** Both terms come from the SAME paired replay-MMR subset. */
export function strengthDescription(row: StrengthFields): string {
  if (row.ratedGames == null) return "Vs expected unavailable: replay-time rating coverage has not been supplied.";
  const rated = row.ratedGames ?? 0;
  if (!rated || row.expectedWins == null || row.winsAboveExpected == null) return `Vs expected unavailable: no decided ranked 1v1 games with both replay-time ratings. ${row.excludedNoMmr ?? 0} missing paired ratings; ${row.excludedIneligible ?? 0} other ineligible records.`;
  const model = row.expectation?.method === "calibrated"
    ? `Calibrated from ${row.expectation.sampleGames.toLocaleString()} original games in ${row.expectation.supportedBins} supported bins.`
    : `Elo fallback, scale ${row.expectation?.eloScale ?? 400}.`;
  const performance = row.perfRating === undefined ? "" : row.perfRating === null ? "No finite performance rating for an all-win or all-loss rated sample." : `Performance rating ${Math.round(row.perfRating).toLocaleString()}.`;
  return `${row.ratedWins ?? 0} rated wins − ${row.expectedWins.toFixed(2)} expected wins = ${signedWins(row.winsAboveExpected)} wins, given who you played. ${rated} paired replay-rated games; ${row.excludedNoMmr ?? 0} missing paired ratings; ${row.excludedIneligible ?? 0} other ineligible records. ${performance} ${model}`;
}

export type MatchupRatingSeries = StrengthFields & {
  matchup: string;
  totalGames: number;
  sampleGames: number;
  windowGames: number;
  points: { date: string; games: number; ratedGames: number; excludedNoMmr: number; perfRating: number | null }[];
};

/** Add disjoint map/matchup subsets without averaging performance ratings.
 * The calibrated inverse is nonlinear and stays on the server. */
export function sumStrength(rows: readonly StrengthFields[]): StrengthFields {
  if (rows.some(row => row.ratedGames == null)) return {};
  const ratedGames = rows.reduce((n, row) => n + (row.ratedGames ?? 0), 0);
  const ratedWins = rows.reduce((n, row) => n + (row.ratedWins ?? 0), 0);
  const expectedWins = ratedGames ? rows.reduce((n, row) => n + (row.expectedWins ?? 0), 0) : null;
  return { ratedGames, ratedWins, expectedWins, winsAboveExpected: expectedWins == null ? null : ratedWins - expectedWins,
    excludedNoMmr: rows.reduce((n, row) => n + (row.excludedNoMmr ?? 0), 0), excludedIneligible: rows.reduce((n, row) => n + (row.excludedIneligible ?? 0), 0), expectation: rows.find(row => row.expectation)?.expectation };
}

/** Null windows interrupt the sparkline; no bridge over an unmeasured or
 * unbounded (0%/100%) performance estimate. */
export function ratingSparkline(points: MatchupRatingSeries["points"]) {
  const measured = points.flatMap(point => point.perfRating != null && Number.isFinite(point.perfRating) ? [point.perfRating] : []);
  if (!measured.length) return { paths: [] as string[], markers: [] as { x: number; y: number; index: number }[], low: null, high: null };
  const low = Math.min(...measured), high = Math.max(...measured), span = Math.max(100, high - low);
  const center = (low + high) / 2;
  const paths: string[] = [], markers: { x: number; y: number; index: number }[] = []; let path = "";
  points.forEach((point, index) => {
    if (point.perfRating == null || !Number.isFinite(point.perfRating)) { if (path) paths.push(path); path = ""; return; }
    const x = 5 + index / Math.max(1, points.length - 1) * 230;
    const y = 30 - (point.perfRating - center) / span * 40;
    markers.push({ x, y, index });
    path += `${path ? " L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  });
  if (path) paths.push(path);
  return { paths, markers, low, high };
}

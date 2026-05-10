/**
 * Pure derivations for the Head-to-Head opponent profile views.
 *
 * The opponent profile API hands the client a games array sorted
 * newest-first. Every chart in the H2H section re-derives its own
 * series from that single array — no extra fetches, no duplicate
 * server work — so the helpers below operate on it as plain data.
 *
 * Inputs are intentionally permissive (every field on `H2HGame` is
 * optional) because the API has surfaced rows from older agents that
 * predate some of the fields we now show.
 */

import { localDateKey } from "@/lib/timeseries";

export type H2HGame = {
  id?: string | null;
  date?: string | null;
  result?: string | null;
  map?: string | null;
  opp_strategy?: string | null;
  opp_race?: string | null;
  my_build?: string | null;
  my_race?: string | null;
  game_length?: number | null;
  macro_score?: number | null;
};

export type CumulativePoint = {
  index: number;
  game: H2HGame;
  isWin: boolean;
  isLoss: boolean;
  cumulativeWins: number;
  cumulativeLosses: number;
  cumulativeWrPct: number;
  rollingWrPct: number | null;
  /** Macro score percentile within this window (0-100), or null when missing. */
  macroPercentile: number | null;
};

export type Bucket = "day" | "week" | "month";

export type PeriodPoint = {
  /** YYYY-MM-DD bucket key (start of bucket, in user tz). */
  date: string;
  wins: number;
  losses: number;
  total: number;
  winRatePct: number;
};

export type GameOutcome = "W" | "L" | "U";

export function gameOutcome(g: H2HGame): GameOutcome {
  const r = (g.result || "").toLowerCase();
  if (r === "win" || r === "victory") return "W";
  if (r === "loss" || r === "defeat") return "L";
  return "U";
}

/**
 * Reverse the API's newest-first array into chronological (oldest →
 * newest) order. Pure on the input; never mutates.
 */
export function chronological(games: H2HGame[]): H2HGame[] {
  return [...games].reverse();
}

/**
 * Drop games whose result is unknown/abandoned. Win/loss are the only
 * states the H2H surface counts toward streaks, WR, and the matrix,
 * matching the pre-existing analyzer behavior.
 */
export function decidedOnly(games: H2HGame[]): H2HGame[] {
  return games.filter((g) => gameOutcome(g) !== "U");
}

/**
 * Cumulative + rolling-window WR for the match-by-match timeline.
 *
 * The rolling window is volume-weighted across actual decided games —
 * `rollingWrPct` is null until the window is full, so the line never
 * lies about its precision. Macro percentiles are nearest-rank within
 * decided games that carried a score; games without a score get a
 * null percentile and a default 4 px dot at the chart layer.
 */
export function cumulativeSeries(
  chronoGames: H2HGame[],
  rollingWindow: number,
): CumulativePoint[] {
  const decided = chronoGames.filter((g) => gameOutcome(g) !== "U");
  const macroSorted = decided
    .map((g) => g.macro_score)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s))
    .sort((a, b) => a - b);
  const out: CumulativePoint[] = [];
  let wins = 0;
  let losses = 0;
  const queue: GameOutcome[] = [];
  let qWins = 0;
  for (let i = 0; i < decided.length; i++) {
    const g = decided[i];
    const o = gameOutcome(g);
    const isWin = o === "W";
    const isLoss = o === "L";
    if (isWin) wins++;
    if (isLoss) losses++;
    queue.push(o);
    if (isWin) qWins++;
    if (queue.length > rollingWindow) {
      const dropped = queue.shift();
      if (dropped === "W") qWins--;
    }
    const total = wins + losses;
    const cumulativeWrPct = total > 0 ? Math.round((wins / total) * 100) : 0;
    const rollingReady = queue.length === rollingWindow && rollingWindow > 0;
    const rollingWrPct = rollingReady
      ? Math.round((qWins / queue.length) * 100)
      : null;
    out.push({
      index: i + 1,
      game: g,
      isWin,
      isLoss,
      cumulativeWins: wins,
      cumulativeLosses: losses,
      cumulativeWrPct,
      rollingWrPct,
      macroPercentile: macroPercentile(g.macro_score, macroSorted),
    });
  }
  return out;
}

function macroPercentile(score: unknown, sorted: number[]): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (sorted.length === 0) return null;
  let count = 0;
  for (const v of sorted) {
    if (v <= score) count++;
    else break;
  }
  return Math.round((count / sorted.length) * 100);
}

/**
 * Bucket games by Day / Week / Month in the supplied timezone and
 * compute period WR. Empty bucket keys (skipped dates) are *not*
 * inserted — the chart layer handles gaps natively. Buckets are
 * sorted ascending by date so the bar chart reads left → right.
 */
export function bucketByPeriod(
  chronoGames: H2HGame[],
  bucket: Bucket,
  timeZone: string,
): PeriodPoint[] {
  const map = new Map<string, { wins: number; losses: number; total: number }>();
  for (const g of chronoGames) {
    if (!g.date) continue;
    const o = gameOutcome(g);
    if (o === "U") continue;
    const key = bucketKey(g.date, bucket, timeZone);
    if (!key) continue;
    const cur = map.get(key) || { wins: 0, losses: 0, total: 0 };
    cur.total++;
    if (o === "W") cur.wins++;
    else cur.losses++;
    map.set(key, cur);
  }
  const out: PeriodPoint[] = [];
  for (const [date, v] of map.entries()) {
    const winRatePct = v.total > 0 ? Math.round((v.wins / v.total) * 100) : 0;
    out.push({ date, wins: v.wins, losses: v.losses, total: v.total, winRatePct });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

function bucketKey(iso: string, bucket: Bucket, timeZone: string): string {
  const dayKey = localDateKey(iso, timeZone);
  if (!dayKey) return "";
  if (bucket === "day") return dayKey;
  if (bucket === "month") return `${dayKey.slice(0, 7)}-01`;
  // Week: Monday-anchored ISO week, in the user's timezone.
  const d = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dayKey;
  const dow = d.getDay();
  const back = dow === 0 ? 6 : dow - 1;
  const monday = new Date(d);
  monday.setDate(monday.getDate() - back);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, "0");
  const day = String(monday.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type SplitMode = "halves" | "thirds";

export type MapPeriodCell = {
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

export type MapPeriodRow = {
  map: string;
  cells: MapPeriodCell[];
  total: number;
  recentWr: number | null;
  earliestWr: number | null;
  trendDeltaPct: number | null;
};

const EMPTY_CELL: MapPeriodCell = { wins: 0, losses: 0, total: 0, winRate: 0 };

/**
 * Split a chronological games array into N equal-ish slices and roll
 * up by map. Used by view 3. Returns rows sorted by total descending,
 * ties broken by alpha map name. The "trend delta" compares the WR
 * of the last slice against the WR of the first slice for each map.
 */
export function mapPeriodGrid(
  chronoGames: H2HGame[],
  split: SplitMode,
): { columns: string[]; rows: MapPeriodRow[] } {
  const slices = split === "halves" ? 2 : 3;
  const columns =
    split === "halves"
      ? ["Earlier half", "Recent half"]
      : ["Earliest third", "Middle third", "Recent third"];
  const decided = decidedOnly(chronoGames);
  if (decided.length === 0) return { columns, rows: [] };
  const sliceBoundaries = computeSliceBoundaries(decided.length, slices);
  const sliceForIndex: number[] = [];
  let cursor = 0;
  for (let i = 0; i < decided.length; i++) {
    while (cursor < sliceBoundaries.length && i >= sliceBoundaries[cursor]) {
      cursor++;
    }
    sliceForIndex.push(Math.min(cursor, slices - 1));
  }
  const byMap = new Map<string, MapPeriodCell[]>();
  for (let i = 0; i < decided.length; i++) {
    const g = decided[i];
    const map = (g.map || "").trim() || "—";
    const sliceIdx = sliceForIndex[i];
    if (!byMap.has(map)) {
      byMap.set(
        map,
        Array.from({ length: slices }, () => ({ ...EMPTY_CELL })),
      );
    }
    const cells = byMap.get(map)!;
    const cell = cells[sliceIdx];
    cell.total++;
    if (gameOutcome(g) === "W") cell.wins++;
    else cell.losses++;
    cell.winRate = cell.total > 0 ? cell.wins / cell.total : 0;
  }
  const rows: MapPeriodRow[] = [];
  for (const [map, cells] of byMap.entries()) {
    const total = cells.reduce((a, c) => a + c.total, 0);
    const firstWithGames = cells.find((c) => c.total > 0);
    const lastWithGames = [...cells].reverse().find((c) => c.total > 0);
    const earliestWr = firstWithGames ? firstWithGames.winRate : null;
    const recentWr = lastWithGames ? lastWithGames.winRate : null;
    const trendDeltaPct =
      earliestWr != null && recentWr != null && firstWithGames !== lastWithGames
        ? Math.round((recentWr - earliestWr) * 100)
        : null;
    rows.push({ map, cells, total, recentWr, earliestWr, trendDeltaPct });
  }
  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.map < b.map ? -1 : a.map > b.map ? 1 : 0;
  });
  return { columns, rows };
}

function computeSliceBoundaries(n: number, slices: number): number[] {
  // Returns the starting index of each slice after the first (length
  // slices - 1). For 7 games into 3 slices: [3, 5] → slices of size
  // [3, 2, 2] which keeps the recent slice the smallest when n
  // doesn't divide evenly.
  const out: number[] = [];
  for (let s = 1; s < slices; s++) {
    out.push(Math.ceil((n * s) / slices));
  }
  return out;
}

export type MatrixCell = {
  myBuild: string;
  oppStrategy: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

export type MatrixGrid = {
  myBuilds: string[];
  oppStrategies: string[];
  cells: Map<string, MatrixCell>;
  /** Map of opponent strategy → (T/P/Z/R/U). */
  oppStrategyRace: Map<string, string>;
};

/**
 * Build a top-K my-build × opponent-strategy crosstab. Picks the top
 * `myBuildLimit` of your own builds and the top `oppLimit` of the
 * opponent's strategies by raw game count, then walks every decided
 * game once to fill the cells. Cells with zero games are returned
 * absent from the map (the renderer shows "—" for missing keys).
 */
export function buildMatchupGrid(
  chronoGames: H2HGame[],
  myBuildLimit: number,
  oppLimit: number,
): MatrixGrid {
  const decided = decidedOnly(chronoGames);
  const myCounts = new Map<string, number>();
  const oppCounts = new Map<string, number>();
  const oppRace = new Map<string, string>();
  for (const g of decided) {
    const my = (g.my_build || "").trim();
    const opp = (g.opp_strategy || "").trim();
    if (my) myCounts.set(my, (myCounts.get(my) || 0) + 1);
    if (opp) {
      oppCounts.set(opp, (oppCounts.get(opp) || 0) + 1);
      const r = (g.opp_race || "").trim().charAt(0).toUpperCase();
      if (r && !oppRace.has(opp)) oppRace.set(opp, r);
    }
  }
  const myBuilds = topByCount(myCounts, myBuildLimit);
  const oppStrategies = topByCount(oppCounts, oppLimit);
  const myKept = new Set(myBuilds);
  const oppKept = new Set(oppStrategies);
  const cells = new Map<string, MatrixCell>();
  for (const g of decided) {
    const my = (g.my_build || "").trim();
    const opp = (g.opp_strategy || "").trim();
    if (!my || !opp || !myKept.has(my) || !oppKept.has(opp)) continue;
    const key = cellKey(my, opp);
    const cur = cells.get(key) || {
      myBuild: my,
      oppStrategy: opp,
      wins: 0,
      losses: 0,
      total: 0,
      winRate: 0,
    };
    cur.total++;
    if (gameOutcome(g) === "W") cur.wins++;
    else cur.losses++;
    cur.winRate = cur.total > 0 ? cur.wins / cur.total : 0;
    cells.set(key, cur);
  }
  return { myBuilds, oppStrategies, cells, oppStrategyRace: oppRace };
}

export function cellKey(myBuild: string, oppStrategy: string): string {
  return `${myBuild} ${oppStrategy}`;
}

function topByCount(counts: Map<string, number>, limit: number): string[] {
  const entries = Array.from(counts.entries());
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return entries.slice(0, limit).map(([name]) => name);
}

/**
 * Total decided games + win rate within an array. Used for headline
 * tiles where the existing `data.totals` already covers the same
 * filter window — we recompute defensively in case a caller hands us
 * a pre-filtered subset.
 */
export function totalsOf(games: H2HGame[]): {
  wins: number;
  losses: number;
  total: number;
  winRate: number;
} {
  let wins = 0;
  let losses = 0;
  for (const g of games) {
    const o = gameOutcome(g);
    if (o === "W") wins++;
    else if (o === "L") losses++;
  }
  const total = wins + losses;
  return { wins, losses, total, winRate: total > 0 ? wins / total : 0 };
}

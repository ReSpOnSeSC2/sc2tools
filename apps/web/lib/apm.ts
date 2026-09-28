/**
 * APM for the per-game surfaces (macro breakdown, replay analysis).
 *
 * The agent uploads an ``apmCurve`` per game, served by
 * GET /v1/games/:gameId/apm-curve: 30-second windows of actions per
 * minute for both players, plus each player's whole-game average.
 * From v3 (agent 0.17.3) the average is the APM StarCraft II recorded in
 * the replay and the windows are scaled to it; v2 counted replay events
 * (commands, selections, control groups), which read about 14% below
 * SC2's own number. SPM (selections per minute) is the selection share
 * of the counted actions, so it is not affected by that scaling.
 *
 * Only curves at version 2+ (agent 0.17.2) are trusted. Older curves
 * credited player 2's commands to player 1, showed player 2 at zero and
 * counted commands only, so they are treated as "not measured" rather
 * than shown wrong. Pure functions only.
 */

/** First curve version with correct attribution and SC2-style APM. */
export const MIN_TRUSTED_APM_CURVE_VERSION = 2;
const DEFAULT_WINDOW_SEC = 30;

/** GET /v1/games/:gameId/apm-curve response (fields we read). */
export interface ApmCurveResponse {
  ok?: boolean;
  v?: number;
  game_length_sec?: number;
  window_sec?: number;
  has_data?: boolean;
  players?: Array<{
    pid?: number;
    is_me?: boolean;
    avg_apm?: number | null;
    samples?: Array<{ t?: number; apm?: number; spm?: number }>;
  }>;
}

export interface ApmSample {
  /** Window start, game seconds. */
  t: number;
  /** Actions per minute across the window. */
  apm: number;
  /** Selections per minute across the window; null when not sent. */
  spm: number | null;
}

export interface ApmSeries {
  /** Whole-game average APM; null when the player had no actions. */
  avg: number | null;
  /**
   * Whole-game average SPM on the same clock as ``avg`` (the time the
   * player was in the game); null when it can't be worked out.
   */
  avgSpm: number | null;
  samples: ApmSample[];
}

export interface GameApm {
  windowSec: number;
  me: ApmSeries;
  /** Null when the curve has no opponent entry. */
  opp: ApmSeries | null;
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function toSeries(
  player: NonNullable<ApmCurveResponse["players"]>[number],
  gameLengthSec: number | null,
  windowSec: number,
): ApmSeries {
  const samples = (player.samples ?? [])
    .filter((s) => finite(s.t) && finite(s.apm) && s.apm >= 0)
    .map((s) => ({
      t: s.t as number,
      apm: s.apm as number,
      spm: finite(s.spm) && s.spm >= 0 ? s.spm : null,
    }))
    .sort((a, b) => a.t - b.t);
  const avg = finite(player.avg_apm) && player.avg_apm > 0 ? player.avg_apm : null;
  return { avg, avgSpm: averageSpm(samples, avg, gameLengthSec, windowSec), samples };
}

/**
 * Whole-game SPM from the windows: the share of the player's actions
 * that were selections, applied to their average APM. That keeps SPM on
 * the same clock as APM (the time the player was in the game) without
 * knowing when they left. Each window's rate is weighted by its length;
 * the last window runs to the end of the game.
 */
function averageSpm(
  samples: ApmSample[],
  avgApm: number | null,
  gameLengthSec: number | null,
  windowSec: number,
): number | null {
  if (avgApm === null || samples.length === 0) return null;
  const last = samples[samples.length - 1];
  const end = gameLengthSec !== null && gameLengthSec > last.t ? gameLengthSec : last.t + windowSec;
  let actions = 0;
  let selections = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (s.spm === null) return null;
    const span = (i + 1 < samples.length ? samples[i + 1].t : end) - s.t;
    actions += s.apm * span;
    selections += s.spm * span;
  }
  return actions > 0 ? (avgApm * selections) / actions : null;
}

/**
 * The trusted APM for one game, or null when there is none to show:
 * no curve, a failed read, a pre-v2 curve, or no data for the uploader.
 */
export function readGameApm(resp: ApmCurveResponse | null | undefined): GameApm | null {
  if (!resp || resp.ok === false || !resp.has_data) return null;
  if (!finite(resp.v) || resp.v < MIN_TRUSTED_APM_CURVE_VERSION) return null;
  const players = Array.isArray(resp.players) ? resp.players : [];
  const mine = players.find((p) => p.is_me === true);
  if (!mine) return null;
  const windowSec = finite(resp.window_sec) && resp.window_sec > 0 ? resp.window_sec : DEFAULT_WINDOW_SEC;
  const gameLengthSec = finite(resp.game_length_sec) && resp.game_length_sec > 0 ? resp.game_length_sec : null;
  const me = toSeries(mine, gameLengthSec, windowSec);
  if (me.avg === null && me.samples.length === 0) return null;
  const theirs = players.find((p) => p.is_me === false);
  return { windowSec, me, opp: theirs ? toSeries(theirs, gameLengthSec, windowSec) : null };
}

/**
 * APM around game time ``t``. Each window's rate is anchored at the
 * window's middle and values between middles are interpolated, so the
 * line follows the player's pace instead of stepping every 30 seconds.
 * Null when the series has no samples.
 */
export function apmAt(series: ApmSeries, windowSec: number, t: number): number | null {
  const s = series.samples;
  if (s.length === 0 || !Number.isFinite(t)) return null;
  const half = windowSec / 2;
  if (t <= s[0].t + half) return s[0].apm;
  const last = s[s.length - 1];
  if (t >= last.t + half) return last.apm;
  let i = 1;
  while (i < s.length && s[i].t + half < t) i += 1;
  const a = s[i - 1];
  const b = s[i];
  const span = b.t - a.t;
  if (span <= 0) return b.apm;
  const frac = (t - (a.t + half)) / span;
  return a.apm + frac * (b.apm - a.apm);
}

/** Attach ``apm`` at each point's time; points are returned unchanged when there is no series. */
export function withApm<T extends { t: number }>(
  points: T[],
  series: ApmSeries | null | undefined,
  windowSec: number,
): Array<T & { apm?: number }> {
  if (!series || series.samples.length === 0) return points;
  return points.map((p) => {
    const apm = apmAt(series, windowSec, p.t);
    return apm === null ? p : { ...p, apm };
  });
}

/** One player's whole-game pace: average APM and SPM. */
export interface GamePace {
  apm: number | null;
  spm: number | null;
}

export function gamePace(series: ApmSeries | null | undefined): GamePace | null {
  return series ? { apm: series.avg, spm: series.avgSpm } : null;
}

/** Whole-number APM for display: "212"; "—" when unknown. */
export function formatApm(v: number | null | undefined): string {
  return finite(v) ? String(Math.round(v)) : "—";
}

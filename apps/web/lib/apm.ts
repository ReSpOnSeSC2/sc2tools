/**
 * APM for the per-game surfaces (macro breakdown, replay analysis).
 *
 * The agent uploads an ``apmCurve`` per game, served by
 * GET /v1/games/:gameId/apm-curve: 30-second windows of actions per
 * minute for both players, plus each player's whole-game average.
 * APM counts every command, selection and control-group action — what
 * StarCraft II's own APM counter shows.
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
  window_sec?: number;
  has_data?: boolean;
  players?: Array<{
    pid?: number;
    is_me?: boolean;
    avg_apm?: number | null;
    samples?: Array<{ t?: number; apm?: number }>;
  }>;
}

export interface ApmSample {
  /** Window start, game seconds. */
  t: number;
  /** Actions per minute across the window. */
  apm: number;
}

export interface ApmSeries {
  /** Whole-game average APM; null when the player had no actions. */
  avg: number | null;
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
): ApmSeries {
  const samples = (player.samples ?? [])
    .filter((s): s is ApmSample => finite(s.t) && finite(s.apm) && s.apm >= 0)
    .map((s) => ({ t: s.t, apm: s.apm }))
    .sort((a, b) => a.t - b.t);
  return { avg: finite(player.avg_apm) && player.avg_apm > 0 ? player.avg_apm : null, samples };
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
  const me = toSeries(mine);
  if (me.avg === null && me.samples.length === 0) return null;
  const theirs = players.find((p) => p.is_me === false);
  const windowSec = finite(resp.window_sec) && resp.window_sec > 0 ? resp.window_sec : DEFAULT_WINDOW_SEC;
  return { windowSec, me, opp: theirs ? toSeries(theirs) : null };
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

/** Whole-number APM for display: "212"; "—" when unknown. */
export function formatApm(v: number | null | undefined): string {
  return finite(v) ? String(Math.round(v)) : "—";
}

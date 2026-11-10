import type { AnyMode } from "./modes";
import type { ScoreResult, ShareSummary } from "./types";

/**
 * Build the plain-text share payload for a finished round. Prefers the
 * mode's own `share()` (which can include detail tables, the full reveal
 * and so on) and falls back to `mode.blurb` plus a one-line outcome, so
 * every mode at least surfaces the question framing, not just its title.
 *
 * The fallback never uses `score.note`: notes are written for the in-app
 * reveal and several name the opponent, which must not leave the app
 * (lib/sharePrivacy.ts). A mode's `share()` is the only place that
 * decides what a card may say.
 */
export function buildShareSummary(
  mode: AnyMode,
  question: unknown,
  answer: unknown,
  score: ScoreResult | null,
): ShareSummary {
  // The Mode<Q, A, S> generic parameters vary by mode; the registry
  // narrows them away to AnyMode here, so the cast is a one-time
  // contract assertion — the runtime values come from the same mode.
  type ModeShareFn = (q: unknown, a: unknown, s: ScoreResult) => ShareSummary;
  const shareFn = (mode as { share?: ModeShareFn }).share;
  if (shareFn && score) {
    try {
      const out = shareFn(question, answer, score);
      if (out && typeof out.question === "string" && Array.isArray(out.answer)) {
        return out;
      }
    } catch {
      // fall through to the default summary
    }
  }
  const fallback =
    score?.outcome === "correct"
      ? "Nailed it."
      : score?.outcome === "partial"
        ? "Close, but not quite."
        : score?.outcome === "wrong"
          ? "Missed this one."
          : "I just played in Arcade.";
  return { question: mode.blurb, answer: [fallback] };
}

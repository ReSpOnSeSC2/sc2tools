/**
 * What a share card may say about other players.
 *
 * A share card (the image and the text sent with it) is public the moment
 * it leaves the app, and the opponents in a player's history never agreed
 * to appear on one. Everything exported therefore refers to an opponent by
 * a neutral label or by race, never by display name, battle tag, toon
 * handle or SC2Pulse id. It never prints a number that gives away their
 * rating, on one card or by adding two cards together: rating gaps are
 * rounded to the nearest 100 everywhere. And it dates a game to the day,
 * never to the second. In-app views keep the real names and exact
 * figures: those are the signed-in player's own private history.
 *
 * Used by the Arcade round cards, the Season Recap card and the per-game
 * battle card.
 */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Neutral label for the n-th item on a card (0-based); past Z it counts.
 *
 * Example: `letteredLabel("Game", 0)` → "Game A";
 * `letteredLabel("Game", 26)` → "Game 27".
 */
export function letteredLabel(noun: string, index: number): string {
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  return `${noun} ${i < LETTERS.length ? LETTERS[i] : String(i + 1)}`;
}

/**
 * Stand-in for an opponent's name on a card that lists several of them.
 *
 * Example: `rivalLabel(2)` → "Rival C".
 */
export function rivalLabel(index: number): string {
  return letteredLabel("Rival", index);
}

const RACE_NAMES: Readonly<Record<string, string>> = {
  P: "Protoss",
  T: "Terran",
  Z: "Zerg",
  R: "Random",
};

/**
 * An opponent described by race only.
 *
 * Example: `anonymousOpponent("Zerg")` → "a Zerg opponent";
 * `anonymousOpponent(null)` → "an opponent".
 */
export function anonymousOpponent(race: string | null | undefined): string {
  const name = RACE_NAMES[String(race ?? "").trim().charAt(0).toUpperCase()];
  return name ? `a ${name} opponent` : "an opponent";
}

/**
 * The range of a real ladder rating. The agent, the replay engine and the
 * API reject anything outside it (`_MIN_PLAUSIBLE_MMR` / `_MAX_PLAUSIBLE_MMR`
 * in the agent and engine, the opponent check in apps/api/src/services/
 * games.js), and 0 is the wire's "not recorded" value.
 */
export const MIN_PLAUSIBLE_MMR = 500;
export const MAX_PLAUSIBLE_MMR = 9999;

/**
 * A rating that is safe to do card arithmetic with, or null.
 *
 * This matters for privacy, not just tidiness: a gap is "theirs minus
 * yours", so a 0 standing in for an unrecorded rating turns the gap into
 * the other player's exact rating.
 *
 * Example: `knownMmr(4100)` → 4100; `knownMmr(0)` → null;
 * `knownMmr(undefined)` → null.
 */
export function knownMmr(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PLAUSIBLE_MMR &&
    value <= MAX_PLAUSIBLE_MMR
    ? value
    : null;
}

/**
 * A game's date for a card: the day, never the time. A time to the second
 * picks one game out of the sharer's public ladder history, and so points
 * at the other player in it.
 *
 * Example: `sharedDay("2026-11-06T22:05:42Z")` → "Nov 6, 2026" (in the
 * viewer's own locale and time zone).
 */
export function sharedDay(iso: string | number | Date | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * MMR gaps on a card are rounded to this step, the same step public
 * reviews round ratings to (apps/api/src/services/reviewRedaction.js).
 */
export const SHARED_MMR_GAP_STEP = 100;

/**
 * Round a rating gap so it cannot be added to the sharer's own rating to
 * recover the other player's exact one. Rounds half away from zero, so
 * +50 and -50 are treated alike.
 *
 * Example: `roundedMmrGap(212)` → 200; `roundedMmrGap(-49)` → 0.
 */
export function roundedMmrGap(gap: number): number {
  if (!Number.isFinite(gap)) return 0;
  const steps = Math.round(Math.abs(gap) / SHARED_MMR_GAP_STEP);
  return steps === 0 ? 0 : Math.sign(gap) * steps * SHARED_MMR_GAP_STEP;
}

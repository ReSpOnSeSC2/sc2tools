import type { LiveGameEnvelope, LiveGamePayload } from "./types";

/**
 * Builder helpers, sanitiser, and per-trigger fingerprints for
 * ``useVoiceReadout``. Split out of the hook module to keep both files
 * under the project's 800-line ceiling and to give the unit tests a
 * dedicated, side-effect-free import surface.
 *
 * Everything here is pure: no React, no DOM, no module-level state.
 * The hook in ``useVoiceReadout.ts`` re-exports these names so existing
 * callers (and the tests) can keep importing from the original module.
 */

/* ============================================================
 * Public builders.
 *
 * Both scouting builders produce the same sentence shape:
 *
 *   ``Facing <Name>, <Race>. <N> MMR. <H2H clause>. Good luck.``
 *
 * They differ only in which payload they read from. The shared layout
 * lives in ``composeScoutingSentence`` so the post-game (Test fire)
 * and live-envelope (real match start) readouts cannot drift apart.
 * ============================================================ */

/**
 * Scouting line for the post-game ``LiveGamePayload`` shape. Used by
 * the Settings → Overlay → Test fire and by any other code path that
 * emits an ``overlay:live`` payload without a ``result`` set.
 */
export function buildScoutingLine(live: LiveGamePayload): string {
  return composeScoutingSentence({
    name: live.oppName,
    race: live.oppRace,
    mmr: extractPositiveMmr(live.oppMmr),
    headToHead: live.headToHead,
  });
}

/**
 * Scouting line for the agent's live ``LiveGameEnvelope`` — what
 * streamers hear at real ladder match start. MMR is preferred from
 * the SC2Pulse profile (current rating) and falls back to the cloud's
 * saved last-game MMR so a Pulse outage doesn't silence the slot.
 */
export function buildLiveGameScoutingLine(env: LiveGameEnvelope): string {
  return composeScoutingSentence({
    name: env.opponent?.name,
    race: env.opponent?.race,
    mmr:
      extractPositiveMmr(env.opponent?.profile?.mmr)
      ?? extractPositiveMmr(env.streamerHistory?.oppMmr),
    headToHead: env.streamerHistory?.headToHead,
  });
}

export function buildMatchEndLine(live: LiveGamePayload): string {
  const word =
    live.result === "win"
      ? "Victory"
      : live.result === "loss"
        ? "Defeat"
        : "Match over";
  const delta = Number(live.mmrDelta);
  if (Number.isFinite(delta) && delta !== 0) {
    const sign = delta > 0 ? "plus" : "minus";
    return `${word}. ${sign} ${Math.abs(delta)} MMR.`;
  }
  return `${word}.`;
}

export function buildCheeseLine(live: LiveGamePayload): string {
  const cheese = Number(live.cheeseProbability);
  if (!Number.isFinite(cheese)) return "Cheese warning.";
  if (cheese >= 0.7) return "High cheese risk.";
  return "Cheese warning.";
}

/**
 * True when the live envelope has at least one usable MMR source —
 * SC2Pulse profile rating OR the cloud's saved last-game MMR. The
 * voice hook waits for this before firing so the spoken line doesn't
 * silently drop the MMR clause when Pulse is a few hundred ms behind
 * the cloud's enrichment.
 */
export function isLiveGameMmrReady(env: LiveGameEnvelope): boolean {
  return (
    extractPositiveMmr(env.opponent?.profile?.mmr) !== null
    || extractPositiveMmr(env.streamerHistory?.oppMmr) !== null
  );
}

/* ============================================================
 * Per-trigger fingerprints — used by the hook to dedupe duplicate
 * payloads. Pure string composition so the hook stays state-free at
 * the boundary.
 * ============================================================ */

export function scoutingFingerprint(live: LiveGamePayload): string {
  return [
    "S",
    (live.oppName || "").toLowerCase(),
    normalizeRace(live.oppRace) || "",
    live.headToHead?.wins ?? "",
    live.headToHead?.losses ?? "",
    live.bestAnswer?.build || "",
    live.isTest ? "T" : "",
  ].join("|");
}

export function matchEndFingerprint(live: LiveGamePayload): string {
  return [
    "E",
    (live.oppName || "").toLowerCase(),
    live.result ?? "",
    live.mmrDelta ?? "",
    live.isTest ? "T" : "",
  ].join("|");
}

export function matchStartFingerprint(live: LiveGamePayload): string {
  return [
    "M",
    (live.oppName || "").toLowerCase(),
    live.headToHead?.wins ?? "",
    live.headToHead?.losses ?? "",
    live.isTest ? "T" : "",
  ].join("|");
}

export function cheeseFingerprint(live: LiveGamePayload): string {
  return [
    "C",
    (live.oppName || "").toLowerCase(),
    Math.round(((live.cheeseProbability ?? 0) as number) * 10),
    live.isTest ? "T" : "",
  ].join("|");
}

/* ============================================================
 * Shared sanitisers.
 * ============================================================ */

/**
 * Strip emojis, markdown punctuation, and other characters Web Speech
 * either skips or pronounces awkwardly. Defensive — payloads can carry
 * arbitrary build-name strings.
 */
export function sanitizeForSpeech(input: string | undefined | null): string {
  if (input == null) return "";
  let s = String(input);
  // Markdown link [text](url) → text.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  // Inline markdown markers.
  s = s.replace(/[*_`~>#]/g, " ");
  // Strip emoji + the joiners/variation selectors that escort them.
  // Web Speech engines either skip these silently or pronounce the
  // CLDR name ("smiling face with smiling eyes"), neither of which we
  // want in a scouting readout.
  s = s.replace(/[\p{Extended_Pictographic}‍️]/gu, "");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Normalise the race string from the agent / replay. Accepts the
 * full word, the single-letter variants the agent occasionally emits
 * (``T`` / ``Z`` / ``P`` / ``R``), and case / whitespace variants.
 * Returns the empty string when the race is unknown so callers can
 * cleanly omit the clause.
 */
export function normalizeRace(race: string | undefined | null): string {
  if (!race) return "";
  const r = race.trim().toLowerCase();
  if (r === "terran" || r === "t") return "Terran";
  if (r === "zerg" || r === "z") return "Zerg";
  if (r === "protoss" || r === "p") return "Protoss";
  if (r === "random" || r === "r") return "random race";
  return "";
}

/* ============================================================
 * Internals — sentence composition.
 *
 * Sharing one composer keeps the post-game and live-envelope readouts
 * structurally identical: same clauses, same order, same fallback
 * behaviour. The Settings → Overlay → Test fire and a real match
 * start cannot drift apart unintentionally.
 * ============================================================ */

interface ScoutingParts {
  name: string | null | undefined;
  race: string | null | undefined;
  mmr: number | null;
  headToHead: { wins: number; losses: number } | null | undefined;
}

/**
 * Compose the canonical scouting sentence from its four parts. Every
 * utterance ends with ``Good luck.``; intermediate clauses are
 * omitted silently when their input is missing or malformed.
 */
function composeScoutingSentence(parts: ScoutingParts): string {
  const segments = [formatFacingClause(parts.name, parts.race)];
  const mmr = formatMmrClause(parts.mmr);
  if (mmr) segments.push(mmr);
  const h2h = formatH2hClause(parts.headToHead);
  if (h2h) segments.push(h2h);
  segments.push("Good luck.");
  return segments.join(" ");
}

function formatFacingClause(
  rawName: string | null | undefined,
  rawRace: string | null | undefined,
): string {
  const name = sanitizeForSpeech(rawName);
  const race = normalizeRace(rawRace);
  if (name && race) return `Facing ${name}, ${race}.`;
  if (name) return `Facing ${name}.`;
  if (race) return `Facing a ${race} opponent.`;
  return "Facing an unknown opponent.";
}

function formatMmrClause(mmr: number | null): string | null {
  return mmr === null ? null : `${mmr} MMR.`;
}

/**
 * Format the H2H clause. Three branches:
 *
 *   - At least one prior encounter → ``You're W and L against them,
 *     <pct> percent win rate.``
 *   - Zero-zero (cloud's confirmed first-meeting signal) →
 *     ``First meeting.``
 *   - ``headToHead`` absent or malformed → ``null`` (caller omits
 *     the clause silently rather than mis-read "first meeting"
 *     against an opponent we may actually have history with).
 */
function formatH2hClause(
  h2h: { wins: number; losses: number } | null | undefined,
): string | null {
  if (!h2h) return null;
  const wins = Number(h2h.wins);
  const losses = Number(h2h.losses);
  if (!Number.isFinite(wins) || !Number.isFinite(losses)) return null;
  if (wins > 0 || losses > 0) {
    const pct = Math.round((wins / (wins + losses)) * 100);
    return `You're ${wins} and ${losses} against them, ${pct} percent win rate.`;
  }
  if (wins === 0 && losses === 0) return "First meeting.";
  return null;
}

/**
 * Return ``mmr`` when it's a finite positive number, else ``null``.
 * "0 MMR" or "NaN MMR" is never a useful readout — drop the clause.
 */
function extractPositiveMmr(mmr: number | null | undefined): number | null {
  return typeof mmr === "number" && Number.isFinite(mmr) && mmr > 0 ? mmr : null;
}

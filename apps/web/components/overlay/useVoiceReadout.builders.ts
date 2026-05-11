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

export const MAX_BEST_ANSWER_LEN = 60;

/* ============================================================
 * Post-game (replay-derived) scouting / match-end / cheese builders.
 * ============================================================ */

export function buildScoutingLine(live: LiveGamePayload): string {
  const parts: string[] = [];
  const name = sanitizeForSpeech(live.oppName);
  const race = normalizeRace(live.oppRace);

  if (name && race) parts.push(`Facing ${name}, ${race}.`);
  else if (name) parts.push(`Facing ${name}.`);
  else if (race) parts.push(`Facing a ${race} opponent.`);
  else parts.push("Facing an unknown opponent.");

  const r = live.headToHead;
  const wins = Number(r?.wins);
  const losses = Number(r?.losses);
  if (Number.isFinite(wins) && Number.isFinite(losses) && (wins > 0 || losses > 0)) {
    parts.push(`You're ${wins} and ${losses} against them.`);
  } else if (r) {
    parts.push("First meeting.");
  }

  const a = live.bestAnswer;
  if (a && a.build) {
    const build = truncate(sanitizeForSpeech(a.build), MAX_BEST_ANSWER_LEN);
    const wr = Number(a.winRate);
    if (build) {
      if (Number.isFinite(wr) && wr > 0) {
        const pct = Math.round(wr * 100);
        parts.push(`Best answer is ${build}, ${pct} percent win rate.`);
      } else {
        parts.push(`Best answer is ${build}.`);
      }
    }
  }

  const cheese = Number(live.cheeseProbability);
  if (Number.isFinite(cheese)) {
    if (cheese >= 0.7) parts.push("High cheese risk — scout early.");
    else if (cheese >= 0.4) parts.push("Possible cheese — scout the natural.");
  }

  return parts.filter(Boolean).join(" ");
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

/* ============================================================
 * Pre-game live-envelope scouting builder.
 * ============================================================ */

/**
 * Pre-game scouting line built from the desktop agent's
 * ``LiveGameEnvelope``. Output order, every clause separated by a
 * single space:
 *
 *   1. ``Facing <Name>, <Race>.`` — drops the race clause when no
 *      recognisable race is supplied (single-letter T/Z/P/R variants
 *      and lower-case forms are normalised); falls back to "Facing an
 *      unknown opponent." when even the name is missing.
 *   2. ``<N> MMR.`` — preferred from ``opponent.profile.mmr`` (the
 *      current Pulse rating), falling back to
 *      ``streamerHistory.oppMmr`` (the cloud's last-game stamp).
 *      Omitted when neither has a usable value — never speaks "0 MMR".
 *   3. Head-to-head:
 *      - ``You're <W> and <L> against them, <pct> percent win rate.``
 *        when ``streamerHistory.headToHead`` is present with at least
 *        one prior encounter.
 *      - ``First meeting.`` when ``streamerHistory.headToHead`` is
 *        present but ``wins + losses === 0`` — the cloud's "confirmed
 *        no prior meetings" signal.
 *      - Omitted silently when ``streamerHistory.headToHead`` is
 *        absent (enrichment hasn't landed yet); the hook's 900 ms
 *        timeout still ensures the streamer hears the rest of the
 *        line.
 *   4. ``Good luck.`` — always last, on every utterance the builder
 *      produces.
 */
export function buildLiveGameScoutingLine(env: LiveGameEnvelope): string {
  const name = sanitizeForSpeech(env.opponent?.name);
  const race = normalizeRace(env.opponent?.race ?? undefined);
  const profile = env.opponent?.profile;
  const history = env.streamerHistory;

  const pulseMmr =
    profile && typeof profile.mmr === "number" && profile.mmr > 0
      ? profile.mmr
      : null;
  const storedMmr =
    typeof history?.oppMmr === "number" && history.oppMmr > 0
      ? history.oppMmr
      : null;
  // SC2Pulse's current rating wins; the cloud's saved last-game MMR is
  // the fallback so a Pulse outage doesn't silence the slot.
  const mmr = pulseMmr !== null ? pulseMmr : storedMmr;

  const parts: string[] = [];
  if (name && race) parts.push(`Facing ${name}, ${race}.`);
  else if (name) parts.push(`Facing ${name}.`);
  else if (race) parts.push(`Facing a ${race} opponent.`);
  else parts.push("Facing an unknown opponent.");

  if (mmr !== null) {
    parts.push(`${mmr} MMR.`);
  }

  const h2h = history?.headToHead;
  if (h2h) {
    const wins = Number(h2h.wins);
    const losses = Number(h2h.losses);
    if (
      Number.isFinite(wins)
      && Number.isFinite(losses)
      && (wins > 0 || losses > 0)
    ) {
      const total = wins + losses;
      const pct = total > 0 ? Math.round((wins / total) * 100) : 0;
      parts.push(
        `You're ${wins} and ${losses} against them, ${pct} percent win rate.`,
      );
    } else if (
      Number.isFinite(wins)
      && Number.isFinite(losses)
      && wins === 0
      && losses === 0
    ) {
      // Cloud confirmed: brand-new opponent.
      parts.push("First meeting.");
    }
    // Else: malformed counts — omit the clause silently rather than
    // mis-read "first meeting" against an opponent we may actually
    // have history with.
  }

  parts.push("Good luck.");
  return parts.filter(Boolean).join(" ");
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
 * Shared helpers.
 * ============================================================ */

/**
 * Strip emojis, markdown punctuation, and other characters Web Speech
 * either skips or pronounces awkwardly. Defensive — payloads can carry
 * arbitrary build-name strings.
 */
export function sanitizeForSpeech(input: string | undefined | null): string {
  if (input == null) return "";
  let s = String(input);
  // Markdown link [text](url) → text
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  // Inline markdown markers
  s = s.replace(/[*_`~>#]/g, " ");
  // Strip emoji + the joiners/variation selectors that escort them.
  // Web Speech engines either skip these silently or pronounce the
  // CLDR name ("smiling face with smiling eyes"), neither of which we
  // want in a scouting readout.
  s = s.replace(/[\p{Extended_Pictographic}\u200D\uFE0F]/gu, "");
  // Collapse whitespace and trim.
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
  // Anything else (empty / "unknown" / agent ambiguity) — drop the race.
  return "";
}

export function truncate(s: string, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  // Trim on a word boundary when possible so the TTS doesn't read a
  // partial word.
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > max - 16 ? cut.slice(0, lastSpace) : cut;
}

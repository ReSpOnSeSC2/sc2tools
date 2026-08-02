import type { LiveGameEnvelope } from "./types";

/**
 * Single source of truth for "what MMR does the current opponent have"
 * when all we have is the agent's pre-game / in-game envelope.
 *
 * Precedence — SC2Pulse's live profile rating first, the cloud's saved
 * last-observed MMR second:
 *
 *   1. ``opponent.profile.mmr`` — the opponent's CURRENT season rating,
 *      resolved by the agent's live bridge a few hundred ms after the
 *      loading screen lands.
 *   2. ``streamerHistory.oppMmr`` — the value stamped on the opponents
 *      row the last time the streamer played them. Can be months and
 *      hundreds of points stale, so it's strictly a fallback for when
 *      Pulse has nothing (player under the season's game threshold,
 *      migrated account, Pulse outage, unranked/off-ladder match).
 *
 * Non-positive and non-finite values are treated as "unknown" at each
 * step, so a ``0`` or ``null`` from Pulse still falls through to the
 * stored value instead of rendering "0 MMR".
 */
export function resolveLiveOpponentMmr(
  liveGame: LiveGameEnvelope | null | undefined,
): number | null {
  return (
    positiveMmr(liveGame?.opponent?.profile?.mmr)
    ?? positiveMmr(liveGame?.streamerHistory?.oppMmr)
  );
}

function positiveMmr(value: unknown): number | null {
  const mmr = Number(value);
  return Number.isFinite(mmr) && mmr > 0 ? mmr : null;
}

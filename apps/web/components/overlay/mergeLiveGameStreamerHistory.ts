import type { LiveGameEnvelope } from "./types";

export type StickyStreamerHistory = {
  gameKey: string;
  opponentName: string;
  streamerHistory: NonNullable<LiveGameEnvelope["streamerHistory"]>;
};

type MergeResult = {
  envelope: LiveGameEnvelope;
  sticky: StickyStreamerHistory | null;
};

/**
 * Preserve rich history across the broker's partial/enriched tick pair, but
 * only while both the match key and directly observed opponent identity agree.
 * Older agents could reuse a gameKey across back-to-back opponents, so the key
 * alone is not sufficient proof that cached history belongs to this envelope.
 */
export function mergeLiveGameStreamerHistory(
  envelope: LiveGameEnvelope,
  sticky: StickyStreamerHistory | null,
): MergeResult {
  const gameKey =
    typeof envelope.gameKey === "string" && envelope.gameKey
      ? envelope.gameKey
      : null;
  if (!gameKey) return { envelope, sticky: null };

  const directOpponent = normalizeOpponentName(envelope.opponent?.name);
  if (envelope.streamerHistory) {
    const historyOpponent = normalizeOpponentName(
      envelope.streamerHistory.oppName,
    );
    // History is opponent-specific, so require positive identity agreement.
    // Missing identity is not safe enough: an old agent may reuse gameKey and
    // an opponent-less synthetic/partial tick must never surface the cache.
    if (!directOpponent || directOpponent !== historyOpponent) {
      return {
        envelope: { ...envelope, streamerHistory: undefined },
        sticky: null,
      };
    }
    return {
      envelope,
      sticky: {
        gameKey,
        opponentName: directOpponent,
        streamerHistory: envelope.streamerHistory,
      },
    };
  }

  if (!sticky || sticky.gameKey !== gameKey) {
    return { envelope, sticky: null };
  }
  if (!directOpponent) {
    // Keep the cache available for the next identified tick, but do not
    // attach it to an envelope whose opponent cannot be proven.
    return { envelope, sticky };
  }
  if (directOpponent !== sticky.opponentName) {
    return { envelope, sticky: null };
  }
  return {
    envelope: { ...envelope, streamerHistory: sticky.streamerHistory },
    sticky,
  };
}

function normalizeOpponentName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

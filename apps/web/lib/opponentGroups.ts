// Opponent "group by player" logic.
//
// SC2Pulse unifies characters two ways, both surfaced by the cloud's
// GET /v1/opponents/pulse-links endpoint:
//   * accountId  — characters on the same Battle.net account (name
//                  changes, multi-region alts of one login).
//   * proId      — community-verified player identity that links
//                  characters ACROSS accounts (the revealed-barcode
//                  case), with proNickname as the name the community
//                  knows them by.
//
// This module folds a user's opponent rows into one group per real
// player: proId wins over accountId (it's the wider link), and rows
// without any linkage stay as their own singleton group. Pure
// functions — the OpponentsTab renders the result, unit tests cover
// the merge rules.

import { isBarcodeName } from "@/lib/sc2pulse";

export type PulseLink = {
  accountId: string | null;
  proId: string | null;
  proNickname: string | null;
};

export type PulseLinksResponse = {
  links: Record<string, PulseLink>;
  /** True when the server left some ids unresolved this call. */
  partial?: boolean;
};

/** The row fields grouping reads and merges. Structural subset of the
 * Opponents tab's `Opp` row so the module stays decoupled from it. */
export interface GroupableOpponent {
  pulseId: string;
  pulseCharacterId?: string | null;
  name?: string;
  revealedName?: string | null;
  wins: number;
  losses: number;
  games: number;
  winRate: number;
  mmr?: number | null;
  lastPlayed: string | null;
}

export type OpponentGroup<T extends GroupableOpponent> = T & {
  /** Every merged identity, most recently played first. */
  identities: T[];
  /** Distinct other names this player has used (displayed name excluded). */
  aliasNames: string[];
  /** Convenience: identities.length. */
  groupSize: number;
};

/**
 * Fold rows into one entry per real player. Each group spreads its
 * primary identity (most recently played) so identity fields like
 * `pulseId` / `pulseCharacterId` keep working — deep-dive navigation
 * targets the primary — then overwrites the aggregate stat columns
 * with the merged totals so sorting and win-rate colouring reflect
 * the whole player.
 *
 * Pass `links` as null/undefined (or empty) to get singleton groups —
 * that's the "grouping off" and "links still loading" rendering path,
 * so the table shape never changes shape mid-load.
 */
export function groupOpponentsByPlayer<T extends GroupableOpponent>(
  rows: T[],
  links?: Record<string, PulseLink> | null,
): OpponentGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = groupKey(row, links);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  const out: OpponentGroup<T>[] = [];
  for (const bucket of buckets.values()) {
    out.push(mergeGroup(bucket));
  }
  return out;
}

/**
 * True when the group (any identity, any alias, the revealed name, or
 * any identity's ids) matches the query. Mirrors the single-row search
 * fields of the Opponents tab so grouping never hides a row the
 * ungrouped search would have found.
 */
export function groupMatchesSearch<T extends GroupableOpponent>(
  group: OpponentGroup<T>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if ((group.revealedName || "").toLowerCase().includes(q)) return true;
  for (const identity of group.identities) {
    const withToon = identity as T & { toonHandle?: string | null };
    if (
      (identity.name || "").toLowerCase().includes(q)
      || (identity.pulseId || "").toLowerCase().includes(q)
      || (withToon.toonHandle || "").toLowerCase().includes(q)
      || String(identity.pulseCharacterId || "").toLowerCase().includes(q)
    ) {
      return true;
    }
  }
  return false;
}

function groupKey(
  row: GroupableOpponent,
  links?: Record<string, PulseLink> | null,
): string {
  const cid = row.pulseCharacterId ? String(row.pulseCharacterId) : "";
  const link = cid && links ? links[cid] : undefined;
  if (link?.proId) return `pro:${link.proId}`;
  if (link?.accountId) return `acct:${link.accountId}`;
  return `solo:${row.pulseId}`;
}

function mergeGroup<T extends GroupableOpponent>(
  bucket: T[],
): OpponentGroup<T> {
  const identities = [...bucket].sort(
    (a, b) => timeOf(b.lastPlayed) - timeOf(a.lastPlayed),
  );
  const primary = identities[0];
  if (identities.length === 1) {
    return {
      ...primary,
      identities,
      aliasNames: [],
      groupSize: 1,
    };
  }
  let wins = 0;
  let losses = 0;
  let games = 0;
  for (const identity of identities) {
    wins += identity.wins || 0;
    losses += identity.losses || 0;
    games += identity.games || 0;
  }
  const displayName = pickDisplayName(identities);
  // The freshest rating we hold for this player, whichever identity
  // carried it — identities are already newest-first.
  const mmrCarrier = identities.find((i) => typeof i.mmr === "number");
  const revealedName = identities
    .map((i) => (i.revealedName || "").trim())
    .find((n) => n.length > 0) || null;
  return {
    ...primary,
    name: displayName,
    revealedName,
    wins,
    losses,
    games,
    winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    mmr: mmrCarrier ? mmrCarrier.mmr : null,
    lastPlayed: primary.lastPlayed,
    identities,
    aliasNames: collectAliases(identities, displayName),
    groupSize: identities.length,
  };
}

/**
 * The player's "most known" name:
 *   1. the SC2Pulse revealed/pro name when any identity carries one —
 *      by definition the name the community knows them by;
 *   2. else the human-readable name they've played the most games
 *      under (barcodes lose to real names);
 *   3. else the most-played name even if it's a barcode.
 */
function pickDisplayName(identities: GroupableOpponent[]): string {
  for (const identity of identities) {
    const revealed = (identity.revealedName || "").trim();
    if (revealed) return revealed;
  }
  const byName = tallyGamesByName(identities);
  const readable = byName.filter((entry) => !isBarcodeName(entry.name));
  const pool = readable.length > 0 ? readable : byName;
  return pool.length > 0 ? pool[0].name : "";
}

/** Distinct names other than the displayed one, most-played first. */
function collectAliases(
  identities: GroupableOpponent[],
  displayName: string,
): string[] {
  return tallyGamesByName(identities)
    .map((entry) => entry.name)
    .filter((name) => name !== displayName);
}

/** Distinct trimmed names ranked by total games, then recency. */
function tallyGamesByName(
  identities: GroupableOpponent[],
): Array<{ name: string; games: number }> {
  const tally = new Map<string, { games: number; order: number }>();
  identities.forEach((identity, index) => {
    const name = (identity.name || "").trim();
    if (!name) return;
    const prev = tally.get(name);
    if (prev) {
      prev.games += identity.games || 0;
    } else {
      // `order` = first (most recent) identity using the name; the
      // recency tie-break for names with equal game counts.
      tally.set(name, { games: identity.games || 0, order: index });
    }
  });
  return [...tally.entries()]
    .sort((a, b) => b[1].games - a[1].games || a[1].order - b[1].order)
    .map(([name, { games }]) => ({ name, games }));
}

function timeOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

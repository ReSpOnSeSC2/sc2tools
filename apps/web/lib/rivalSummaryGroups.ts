import { rivalKeys } from "./useRivals";
import type { OpponentGroup, PulseLink } from "./opponentGroups";
import type { RivalSummaryGroup } from "./useRivalSummary";
import type { Opp } from "@/components/analyzer/opponents/types";

/** A star is a player even when the table displays individual accounts. */
export function rivalSummaryGroups(rows: OpponentGroup<Opp>[], keys: string[], links?: Record<string, PulseLink> | null): RivalSummaryGroup[] {
  const groups = new Map<string, { group: RivalSummaryGroup; last: number }>();
  for (const row of rows) {
    const key = rivalKeys(row, links).find(candidate => keys.includes(candidate));
    if (!key) continue;
    const last = row.lastPlayed ? Date.parse(row.lastPlayed) : -Infinity;
    const known = groups.get(key);
    if (known) {
      known.group.pulseIds = [...new Set([...known.group.pulseIds, ...row.identities.map(identity => identity.pulseId)])];
      if (last > known.last) { known.group.primaryPulseId = row.pulseId; known.last = last; }
    } else groups.set(key, { group: { key, pulseIds: row.identities.map(identity => identity.pulseId), primaryPulseId: row.pulseId }, last });
  }
  let accounts = 0;
  return [...groups.values()].map(value => value.group).sort((a,b) => a.key.localeCompare(b.key)).filter(group => {
    if (accounts + group.pulseIds.length > 500) return false;
    accounts += group.pulseIds.length; return true;
  }).slice(0,50);
}

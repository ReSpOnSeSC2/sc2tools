"use client";

import useSWR from "swr";
import { API_BASE } from "@/lib/clientApi";
import type { PlayerChannels } from "./PlayerChannelLinks";

type Identity = { pulseCharacterId?: string | null; toonHandle?: string | null; pulseId?: string | null };
type ResolvedPlayer = Identity & { channels: PlayerChannels; displayName?: string | null };
const NUMERIC_ID = /^[1-9]\d{0,19}$/;
const TOON_ID = /^[1-9]\d?-S2-[1-9]\d?-\d{1,20}$/i;

export function channelIdentity(player: Identity): { pulseCharacterId?: string; toonHandle?: string } {
  const pulseCharacterId = player.pulseCharacterId || (NUMERIC_ID.test(player.pulseId || "") ? player.pulseId : null);
  const toonHandle = player.toonHandle || (TOON_ID.test(player.pulseId || "") ? player.pulseId : null);
  return {
    ...(NUMERIC_ID.test(pulseCharacterId || "") ? { pulseCharacterId: pulseCharacterId! } : {}),
    ...(TOON_ID.test(toonHandle || "") ? { toonHandle: toonHandle!.toUpperCase() } : {}),
  };
}

/** Batch public identities once per list; no per-row fetch or name matching. */
export function usePlayerChannels(players: readonly Identity[]) {
  const identities = Array.from(new Set(players.map(channelIdentity).filter((p) => Object.keys(p).length).map((p) => JSON.stringify(p)))).sort();
  const serialized = identities.length ? `[${identities.join(",")}]` : null;
  const { data } = useSWR<ResolvedPlayer[]>(serialized ? ["player-channels", serialized] : null,
    async ([, raw]: readonly [string, string]) => {
      const input = JSON.parse(raw) as Identity[];
      const results: ResolvedPlayer[] = [];
      // One request at a time, at the API's 200-identity cap. A full 5,000-row
      // opponent history fits inside the public rate limit without fan-out.
      for (let offset = 0; offset < input.length; offset += 200) {
        const batch = input.slice(offset, offset + 200);
        const response = await fetch(`${API_BASE}/v1/player-channels/resolve`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ players: batch }), cache: "no-store",
        });
        if (!response.ok) throw new Error("Player channels unavailable");
        const page = await response.json() as { players?: ResolvedPlayer[] };
        if (Array.isArray(page.players)) results.push(...page.players);
      }
      return results;
    }, { dedupingInterval: 30_000, errorRetryCount: 1, keepPreviousData: false });
  const byIdentity = new Map<string, ResolvedPlayer>();
  for (const player of data || []) {
    if (!player || typeof player !== "object") continue;
    byIdentity.set(JSON.stringify(channelIdentity(player)), player);
  }
  return (player: Identity): PlayerChannels | undefined => {
    // Retain the complete tuple: a contradictory toon/Pulse pair must never
    // borrow the result of a different row that happens to share one key.
    const channels = byIdentity.get(JSON.stringify(channelIdentity(player)))?.channels;
    return channels?.twitch || channels?.youtube ? channels : undefined;
  };
}

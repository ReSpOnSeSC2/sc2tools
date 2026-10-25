import type { LiveGameEnvelope } from "@/components/overlay/types";
import { resolveLiveOpponentMmr } from "@/components/overlay/liveGameOpponentMmr";

const text = (value: unknown, max = 160) => typeof value === "string" ? value.trim().slice(0, max) : "";
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown) => Array.isArray(value) ? value.slice(0, 5).map(record) : [];
const active = new Set(["match_loading", "match_started", "match_in_progress"]);
export const liveScoutingActive = (live: LiveGameEnvelope | null) => !!live && active.has(live.phase) && live.isReplay !== true;
export type DockScouting = {
  name: string; race: string; aka: string; mmr: number | null; league: string;
  h2h: { wins: number; losses: number } | null; enriched: boolean;
  rival: string; rematch: boolean; openings: { name: string; samples: number; of: number }[];
  answer: string; cheese: number | null;
};

/** New object, explicit stream-safe allowlist. No notes, identities or replay links. */
export function projectDockScouting(live: LiveGameEnvelope | null): DockScouting | null {
  if (!liveScoutingActive(live)) return null;
  const opponent = record(live?.opponent), history = matchedHistory(live);
  const profile = record(opponent.profile), h2h = record(history.headToHead);
  const wins = count(h2h.wins), losses = count(h2h.losses);
  const mmr = resolveLiveOpponentMmr({ ...live, streamerHistory: history } as LiveGameEnvelope);
  const cheese = history.cheeseProbability;
  const openings = list(history.openingHistory).flatMap(row => {
    const name = text(row.name), samples = count(row.samples), of = count(row.of);
    return name && samples !== null && of !== null && of > 0 && samples <= of ? [{ name, samples, of }] : [];
  }).slice(0, 3);
  const fav = record(history.favOpening), samples = count(fav.samples), of = count(fav.of);
  if (!openings.length && text(fav.name) && samples !== null && of !== null && of > 0 && samples <= of) openings.push({ name: text(fav.name), samples, of });
  return {
    name: text(opponent.name || history.oppName, 120), race: text(opponent.race || history.oppRace, 24),
    aka: text(opponent.revealedName || history.oppRevealedName, 120), mmr, league: text(profile.league, 32),
    h2h: wins !== null && losses !== null ? { wins, losses } : null,
    enriched: Object.keys(history).length > 0,
    rival: Object.keys(record(history.rival)).length ? record(history.rival).starred === true || (wins ?? 0) + (losses ?? 0) >= 6 ? "Rival" : "Familiar" : "",
    rematch: record(history.rematch).isRematch === true,
    openings, answer: text(record(history.bestAnswer).build),
    cheese: typeof cheese === "number" && Number.isFinite(cheese) && cheese >= .4 && cheese <= 1 ? cheese : null,
  };
}

function matchedHistory(live: LiveGameEnvelope | null) {
  const history = sameOpponentHistory(live);
  return history.opponentIdentityMatched === false ? { oppName: history.oppName, opponentIdentityMatched: false } : history;
}
function sameOpponentHistory(live: LiveGameEnvelope | null) {
  const history = record(live?.streamerHistory), name = text(live?.opponent?.name, 120).toLowerCase();
  if (!name || name !== text(history.oppName, 120).toLowerCase()) return {};
  const toon = live?.opponent?.toonHandle;
  if (typeof toon === "string" && /^\d+-S2-\d+-\d+$/.test(toon) && history.oppPulseId !== toon) return {};
  return history;
}

/** Owner-only additions, kept separate from the Dock model above. */
export function privateScouting(live: LiveGameEnvelope | null) {
  const source = sameOpponentHistory(live), history = matchedHistory(live), rawId = source.oppPulseId;
  const pulseId = typeof rawId === "string" && /^\d+-S2-\d+-\d+$/.test(rawId) && rawId.length <= 80 ? rawId : null;
  return {
    pulseId, writable: source.opponentNotesWritable === true,
    note: pulseId ? text(record(source.opponentNotes).text, 500) : "",
    readAloud: record(source.opponentNotes).readAloud === true,
    recent: list(history.recentGames).filter(row => ["Win", "Loss", "Tie"].includes(String(row.result))).map(row => ({
      result: String(row.result),
      gameId: typeof row.gameId === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(row.gameId) ? row.gameId : null,
      map: text(row.map, 120), length: text(row.lengthText, 20),
      build: text(row.myBuild), opener: text(row.oppBuild),
    })),
  };
}

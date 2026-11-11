import { resultLabel } from "@/components/analyzer/game/types";

export function sharedReplayMap(map?: string | null): string | null {
  const name = map?.trim();
  return name && !/^unknown(?: map)?$/i.test(name) ? name : null;
}

export function sharedReplayTitle(player: string, game: { result?: string | null; matchup?: string | null; map?: string | null }): string {
  const result = resultLabel(game.result);
  const map = sharedReplayMap(game.map);
  const where = game.matchup && map ? game.matchup + " on " + map : game.matchup || map;
  const summary = [result === "Unknown" ? null : result, where].filter(Boolean).join(" · ");
  return (summary ? summary + " — " : "") + player + "'s replay";
}

import type { GameStoryInput } from "@/lib/gameStory";

const sample = (time: number, army_value: number, food_workers: number, minerals_collection_rate: number) => ({ time, army_value, food_workers, minerals_collection_rate, vespene_collection_rate: 100 });
export const STORY_INPUT: GameStoryInput = {
  gameId: "story-ui", result: "Victory",
  statsEvents: [sample(0, 500, 12, 400), sample(30, 1500, 20, 800), sample(60, 2200, 28, 1000), sample(90, 1800, 30, 1100)],
  oppStatsEvents: [sample(0, 700, 14, 500), sample(30, 900, 18, 700), sample(60, 1100, 24, 900), sample(90, 1400, 28, 1000)],
  casualtyEvents: [
    { time: 190, owner: "me", killer: "opp", category: "units", name: "Marine" },
    { time: 195, owner: "opp", killer: "me", category: "units", name: "Marauder" },
    { time: 300, owner: "me", killer: "opp", category: "units", name: "SiegeTank" },
    { time: 301, owner: "opp", killer: "me", category: "units", name: "Marine" },
    { time: 450, owner: "me", killer: "opp", category: "units", name: "UnknownFixtureUnit" },
    { time: 451, owner: "opp", killer: "me", category: "units", name: "Marine" },
  ],
  supplyBlockedSeconds: 15, supplyBlockWindows: [{ start: 70, end: 85, blocked_sec: 15 }],
  leaks: [{ name: "Unspent minerals", detail: "The fixed macro rules price this banked-resource sample.", mineral_cost: 400, time: 75 }],
};

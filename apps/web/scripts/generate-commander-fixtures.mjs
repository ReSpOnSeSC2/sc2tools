// Run from apps/web. The API remains the reference for taxonomy and axis boundaries.
import { writeFileSync } from "node:fs";
import api from "../../api/src/services/playerStyleFingerprint.js";

const vocabulary = Object.fromEntries(api.AXIS_ORDER.map(axis => [axis,
  Object.entries(api.AXIS_VOCABULARY[axis]).map(([key, { label, noun, adjective }]) => ({ key, label, noun, adjective })),
]));
const axes = api.AXIS_ORDER.map(axis => vocabulary[axis]);
const combinations = [];
for (const a of [null, ...axes[0]]) {
  for (const b of [null, ...axes[1]]) {
    for (const c of [null, ...axes[2]]) {
      const categories = [a, b, c].map(entry => entry?.key ?? null);
      const { name, complete } = api.deriveArchetype(categories.map((category, index) => ({ key: api.AXIS_ORDER[index], category })));
      combinations.push({ categories, name, complete });
    }
  }
}

const repeat = (value, count) => Array(count).fill(value);
const repertoires = [repeat("A", 9), repeat("A", 10), [...repeat("A", 8), ...repeat("B", 2)],
  [" A ", "a", "a", "A", "B", "B", "C", "C", "D", "D", "Unclassified", "Game too short", "None"],
  Array.from({ length: 10 }, (_, index) => String(index)), Array.from({ length: 6 }, (_, index) => repeat(String(index), 2)).flat()];
const paces = [repeat(600, 9), repeat(45, 10), repeat(299, 10), repeat(300, 10), repeat(600, 10), repeat(601, 10),
  repeat(901, 10), [...repeat(299, 3), ...repeat(600, 4), ...repeat(901, 3)],
  [...repeat(299, 3), ...repeat(450, 4), ...repeat(800, 3)], [...repeat(300, 3), ...repeat(900, 4), ...repeat(1000, 3)],
  [44, ...repeat(300, 9)]];
const matchupCounts = [[0, 4, 8], [8, 4, 4], [4, 4, 4], [0, 8, 8], [5, 4, 5], [4, 5, 4], [4, 4, 4, 7]];
const projection = ({ category, sampleSize }) => ({ category, sampleSize });
const golden = {
  combinations,
  repertoires: repertoires.map(input => ({ input, expected: projection(api.repertoireAxis(input.map(myBuild => ({ myBuild })))) })),
  paces: paces.map(input => ({ input, expected: projection(api.paceAxis(input.map(durationSec => ({ durationSec })))) })),
  matchups: matchupCounts.map(([p, t, z, zGames = 8]) => {
    const input = [p, t, z].map((wins, index) => ({ matchup: `Pv${"PTZ"[index]}`, wins, decidedGames: index === 2 ? zGames : 8 }));
    const result = api.matchupEdgeAxis("PvP", input);
    return { input, expected: { ...projection(result), category: input.every(row => row.decidedGames >= api.MIN_MATCHUP_GAMES) ? result.category : null } };
  }),
};

writeFileSync(new URL("../lib/instant/commanderTaxonomy.v1.json", import.meta.url), JSON.stringify(vocabulary, null, 2) + "\n");
writeFileSync(new URL("../lib/instant/__tests__/fixtures/commanderGolden.generated.json", import.meta.url), JSON.stringify(golden) + "\n");

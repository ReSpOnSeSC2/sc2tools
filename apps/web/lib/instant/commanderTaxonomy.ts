import vocabulary from "./commanderTaxonomy.v1.json";

export const COMMANDER_AXES = ["repertoire", "pace", "matchup_edge"] as const;
export type CommanderAxisKey = (typeof COMMANDER_AXES)[number];
export type CommanderCategories = readonly [string | null, string | null, string | null];

const axes = COMMANDER_AXES.map(key => vocabulary[key]);
const COMPLETE_COUNT = axes.reduce((count, axis) => count * axis.length, 1);

export function commanderAxisLabel(axis: CommanderAxisKey, category: string | null): string | null {
  return vocabulary[axis].find(entry => entry.key === category)?.label ?? null;
}

/** The fixed API taxonomy uses every available category in a stable order. */
export function commanderName(categories: CommanderCategories): string {
  const [core, ...modifiers] = axes.flatMap((axis, index) => axis.find(entry => entry.key === categories[index]) ?? []);
  if (!core) return "Profile Still Forming";
  return [...modifiers.map(entry => entry.adjective).reverse(), core.noun].join(" ");
}

/** The v2 report wire stores the complete tuple as a single bounded integer. */
export function commanderCode(categories: CommanderCategories): number | null {
  const indexes = axes.map((axis, index) => axis.findIndex(entry => entry.key === categories[index]));
  return indexes.some(index => index < 0) ? null : indexes.reduce((code, index, axis) => code * axes[axis].length + index, 0);
}

export function commanderNameFromCode(code: unknown): string | null {
  if (typeof code !== "number" || !Number.isInteger(code) || code < 0 || code >= COMPLETE_COUNT) return null;
  const [repertoire, pace, matchup] = axes;
  const paceWidth = pace.length * matchup.length;
  return commanderName([repertoire[Math.floor(code / paceWidth)].key,
    pace[Math.floor(code / matchup.length) % pace.length].key, matchup[code % matchup.length].key]);
}

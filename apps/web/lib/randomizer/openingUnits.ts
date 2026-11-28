/**
 * What each opening unit is: its name, the structure it comes from and its
 * shipped SC2 icon. This list holds no eligibility: which units a matchup
 * draws from lives in `openingUnitPools.ts`. Each `building` is the one
 * structure `apps/api/src/config/presetCatalog.json` lists for the unit
 * under `unitTechPrerequisites` (the Gateway units, which that table omits,
 * come from the Gateway), and `__tests__/openingUnitPools.test.ts` pins it.
 */
import { getIconPath } from "@/lib/sc2-icons";
import {
  OPENING_UNIT_IDS,
  type OpeningUnitId,
  type PlayedRace,
} from "./types";

export interface OpeningUnitMeta {
  id: OpeningUnitId;
  race: PlayedRace;
  name: string;
  /** The structure it comes from, as the preset catalog names it. */
  building: string;
  iconPath: string;
}

const UNIT_FACTS: Readonly<Record<OpeningUnitId, { name: string; building: string }>> = {
  zealot: { name: "Zealot", building: "Gateway" },
  stalker: { name: "Stalker", building: "Gateway" },
  sentry: { name: "Sentry", building: "Gateway" },
  adept: { name: "Adept", building: "Gateway" },
  marine: { name: "Marine", building: "Barracks" },
  reaper: { name: "Reaper", building: "Barracks" },
  marauder: { name: "Marauder", building: "Barracks" },
  hellion: { name: "Hellion", building: "Factory" },
  widowmine: { name: "Widow Mine", building: "Factory" },
  siegetank: { name: "Siege Tank", building: "Factory" },
  cyclone: { name: "Cyclone", building: "Factory" },
  viking: { name: "Viking", building: "Starport" },
  liberator: { name: "Liberator", building: "Starport" },
  banshee: { name: "Banshee", building: "Starport" },
  raven: { name: "Raven", building: "Starport" },
  zergling: { name: "Zergling", building: "Spawning Pool" },
  queen: { name: "Queen", building: "Spawning Pool" },
  baneling: { name: "Baneling", building: "Baneling Nest" },
  roach: { name: "Roach", building: "Roach Warren" },
  ravager: { name: "Ravager", building: "Roach Warren" },
  hydralisk: { name: "Hydralisk", building: "Hydralisk Den" },
  lurker: { name: "Lurker", building: "Lurker Den" },
  mutalisk: { name: "Mutalisk", building: "Spire" },
};

const RACES: readonly PlayedRace[] = ["Protoss", "Terran", "Zerg"];

/** Every opening unit, race by race in canonical order. */
export const OPENING_UNITS: ReadonlyArray<OpeningUnitMeta> = RACES.flatMap(
  (race) => OPENING_UNIT_IDS[race].map((id) => {
    const { name, building } = UNIT_FACTS[id];
    const iconPath = getIconPath(name, "unit");
    if (!iconPath) throw new Error(`Missing SC2 unit icon for ${name}`);
    return { id, race, name, building, iconPath };
  }),
);

const META_BY_ID = new Map(OPENING_UNITS.map((unit) => [unit.id, unit]));

export function openingUnitMeta(id: OpeningUnitId): OpeningUnitMeta {
  return META_BY_ID.get(id) as OpeningUnitMeta;
}

import { sanitizeMapPlayback } from "../mapReplay";
import { unitCost } from "../mapReplayLosses";
import { selectFights } from "./buildPack";
import { DAILY_VERSION, readDailyPack, type DailyPack } from "./clip";
import { FIGHTS_PER_DAY, PRACTICE_DAYS } from "./rules";

const PAIRS = [
  ["Marine", "Zergling"], ["Zealot", "Marine"], ["Zergling", "Zealot"],
  ["Stalker", "Stalker"], ["Marauder", "Marauder"], ["Marine", "Marine"],
] as const;
const SPLITS = [[1, 5], [3, 5], [3, 3], [5, 3], [5, 1]] as const;

type Side = {
  unit: string;
  owner: "me" | "opp";
  multiplier: number;
  losses: number;
  contact: number;
  seed: number;
};

function army(side: Side) {
  const { unit, owner, multiplier, losses, contact, seed } = side;
  const casualties = losses * multiplier;
  const direction = owner === "me" ? 1 : -1;
  return Array.from({ length: casualties + 4 + (seed % 5) }, (_, i) => {
    const x = 41 - direction * (8 + Math.floor(i / 5) * 2);
    const y = 33 + (i % 5 - 2) * 2 + (owner === "me" ? -1 : 1);
    const died = i < casualties ? contact + 1 + (i % 5) * 0.8 + Math.floor(i / 5) * 0.15 : null;
    const end = died ?? contact + 9;
    const born = contact - 2;
    const track = Array.from({ length: Math.floor((end - born) * 2) + 1 }, (_, tick) => born + tick / 2);
    if (track[track.length - 1] < end) track.push(end);
    const shots = [contact, contact + 1.3 + (i % 3) * 0.1, contact + 2.6, contact + 4.1]
      .filter(time => time < end);
    return {
      owner, name: unit, born, died,
      wp: track.flatMap(time => {
        const stride = Math.min(8, (time - born) * 2.5);
        return [time, x + direction * stride, y + direction * stride / 8];
      }),
      attacks: shots,
      aim: shots.flatMap(time => [time, 41, y + direction]),
    };
  });
}

/** The five score buckets have different visible army mixes over seven days. */
function fixtureFight(seed: number) {
  const [left, right] = PAIRS[seed % PAIRS.length];
  const [first, second] = SPLITS[(seed + Math.floor(seed / FIGHTS_PER_DAY)) % SPLITS.length];
  const leftCost = unitCost(left, "after"), rightCost = unitCost(right, "after");
  if (!leftCost || !rightCost) throw new Error("Fixture unit price is missing.");
  const a = leftCost.minerals + leftCost.gas, b = rightCost.minerals + rightCost.gas;
  const multiplier = Math.max(a, b);
  if (multiplier % Math.min(a, b)) throw new Error("Fixture units do not have commensurable prices.");
  const contact = 13 + seed % 8;
  const units = [
    ...army({ unit: left, owner: "me", multiplier: multiplier / a, losses: first, contact, seed }),
    ...army({ unit: right, owner: "opp", multiplier: multiplier / b, losses: second, contact, seed: seed + 2 }),
  ];
  const playback = sanitizeMapPlayback({
    v: 7, gameLength: 60, bounds: { minX: 0, minY: 0, maxX: 82, maxY: 66 },
    fidelity: { positions: "engine", paths: "observed", attacks: "observed", creep: "estimated", complete: true },
    units,
  });
  const result = playback && selectFights(playback, { start: 0, end: 60 }, "after", Math.floor(seed / FIGHTS_PER_DAY))[0];
  if (!result) throw new Error("Practice fight did not meet the selection rules at slot " + (seed + 1));
  return result.fight;
}

export function fixtureWeek(): DailyPack[] {
  return Array.from({ length: PRACTICE_DAYS }, (_, day) => {
    const fights = Array.from({ length: FIGHTS_PER_DAY }, (_, slot) => fixtureFight(day * FIGHTS_PER_DAY + slot));
    const pack = readDailyPack({ version: DAILY_VERSION, fights });
    if (!pack) throw new Error("Practice pack failed public validation.");
    return pack;
  });
}

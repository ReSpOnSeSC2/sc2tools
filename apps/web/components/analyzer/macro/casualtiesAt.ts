import type {
  CasualtyCategory,
  CasualtyEvent,
  CasualtySide,
} from "./MacroBreakdownPanel.types";
import type { PatchEra } from "@/lib/meta";
import { casualtyCost, type CasualtyResourceCost } from "./casualtyCost";

export const CASUALTY_CATEGORIES: readonly CasualtyCategory[] = ["units", "buildings", "workers"];

export interface CasualtyCostTotals extends CasualtyResourceCost {
  /** Deaths with an unknown price; known prices remain useful as a subtotal. */
  unpriced: number;
}
export interface CasualtyTally {
  killed: number;
  lost: number;
  killedCost: CasualtyCostTotals;
  lostCost: CasualtyCostTotals;
}
type Counts = Record<CasualtyCategory, CasualtyTally>;
export type CasualtyCounts = Record<CasualtySide, Counts>;
export interface CasualtyPoint {
  time: number;
  counts: CasualtyCounts;
}

const emptyCost = (): CasualtyCostTotals => ({ minerals: 0, gas: 0, unpriced: 0 });
const emptyTally = (): CasualtyTally => ({ killed: 0, lost: 0, killedCost: emptyCost(), lostCost: emptyCost() });
const emptySide = (): Counts => ({ units: emptyTally(), buildings: emptyTally(), workers: emptyTally() });
export const emptyCasualtyCounts = (): CasualtyCounts => ({ me: emptySide(), opp: emptySide() });

const cloneTally = (tally: CasualtyTally): CasualtyTally => ({
  ...tally, killedCost: { ...tally.killedCost }, lostCost: { ...tally.lostCost },
});
const cloneSide = (side: Counts): Counts => ({
  units: cloneTally(side.units), buildings: cloneTally(side.buildings), workers: cloneTally(side.workers),
});

function addCost(total: CasualtyCostTotals, cost: Readonly<CasualtyResourceCost> | null): void {
  if (cost) {
    total.minerals += cost.minerals;
    total.gas += cost.gas;
  } else {
    total.unpriced += 1;
  }
}

/** Build once per replay so scrubbing only needs a binary search. Grouping
 * simultaneous deaths also makes their inclusion at an exact time atomic. */
export function buildCasualtyTimeline(events: readonly CasualtyEvent[], patchEra?: PatchEra | null): CasualtyPoint[] {
  const ordered = events.filter((event) =>
    Number.isFinite(event.time) && event.time >= 0 &&
    (event.owner === "me" || event.owner === "opp") &&
    CASUALTY_CATEGORIES.includes(event.category),
  ).slice().sort((a, b) => a.time - b.time);
  const timeline: CasualtyPoint[] = [];
  let counts = emptyCasualtyCounts();
  for (const event of ordered) {
    if (timeline[timeline.length - 1]?.time !== event.time) {
      counts = {
        me: cloneSide(counts.me),
        opp: cloneSide(counts.opp),
      };
      timeline.push({ time: event.time, counts });
    }
    counts[event.owner][event.category].lost += 1;
    const cost = casualtyCost(event.name, patchEra);
    addCost(counts[event.owner][event.category].lostCost, cost);
    if ((event.killer === "me" || event.killer === "opp") && event.killer !== event.owner) {
      counts[event.killer][event.category].killed += 1;
      addCost(counts[event.killer][event.category].killedCost, cost);
    }
  }
  return timeline;
}

export function casualtiesAt(timeline: readonly CasualtyPoint[], time: number): CasualtyCounts {
  if (!Number.isFinite(time) || time < 0) return emptyCasualtyCounts();
  let lo = 0;
  let hi = timeline.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? timeline[lo - 1].counts : emptyCasualtyCounts();
}

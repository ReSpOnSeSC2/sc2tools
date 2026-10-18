import type {
  CasualtyCategory,
  CasualtyEvent,
  CasualtySide,
} from "./MacroBreakdownPanel.types";

export const CASUALTY_CATEGORIES: readonly CasualtyCategory[] = ["units", "buildings", "workers"];

type Counts = Record<CasualtyCategory, { killed: number; lost: number }>;
export type CasualtyCounts = Record<CasualtySide, Counts>;
export interface CasualtyPoint {
  time: number;
  counts: CasualtyCounts;
}

const emptySide = (): Counts => ({
  units: { killed: 0, lost: 0 },
  buildings: { killed: 0, lost: 0 },
  workers: { killed: 0, lost: 0 },
});
export const emptyCasualtyCounts = (): CasualtyCounts => ({ me: emptySide(), opp: emptySide() });

/** Build once per replay so scrubbing only needs a binary search. Grouping
 * simultaneous deaths also makes their inclusion at an exact time atomic. */
export function buildCasualtyTimeline(events: readonly CasualtyEvent[]): CasualtyPoint[] {
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
        me: {
          units: { ...counts.me.units }, buildings: { ...counts.me.buildings }, workers: { ...counts.me.workers },
        },
        opp: {
          units: { ...counts.opp.units }, buildings: { ...counts.opp.buildings }, workers: { ...counts.opp.workers },
        },
      };
      timeline.push({ time: event.time, counts });
    }
    counts[event.owner][event.category].lost += 1;
    if ((event.killer === "me" || event.killer === "opp") && event.killer !== event.owner) {
      counts[event.killer][event.category].killed += 1;
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

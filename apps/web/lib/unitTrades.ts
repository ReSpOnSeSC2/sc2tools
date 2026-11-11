import type { CasualtyEvent, CasualtySide } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { GameBuildOrderEvent } from "@/components/analyzer/game/types";
import { getUnitCost } from "@/lib/sc2-units";

type Era = Parameters<typeof getUnitCost>[1];
type Counts = Map<string, number>;
type TradeRow = {
  name: string; recordedBuilt: number; lost: number; kills: number;
  resourcesLost: number; resourcesKilled: number; unknownCosts: number;
  lifespan: number[]; killed: Counts; diedTo: Counts;
};

function count(rows: Counts, name: string) {
  rows.set(name, (rows.get(name) ?? 0) + 1);
}

export function unitTrades(deaths: readonly CasualtyEvent[], builds: readonly GameBuildOrderEvent[], side: CasualtySide, era?: Era, built?: Record<string, number>) {
  const rows = new Map<string, TradeRow>();
  function row(name: string) {
    let value = rows.get(name);
    if (!value) {
      value = { name, recordedBuilt: 0, lost: 0, kills: 0, resourcesLost: 0, resourcesKilled: 0,
        unknownCosts: 0, lifespan: [], killed: new Map(), diedTo: new Map() };
      rows.set(name, value);
    }
    return value;
  }
  if (built) {
    for (const [name, count] of Object.entries(built)) row(name).recordedBuilt = count;
  } else {
    for (const build of builds) {
      if (!build.is_building && build.category !== "upgrade" && build.name) row(build.name).recordedBuilt++;
    }
  }
  for (const death of deaths) {
    if (death.category === "buildings") continue;
    const cost = getUnitCost(death.name, era), value = cost ? cost.m + cost.g : 0;
    if (death.owner === side) {
      const victim = row(death.name);
      victim.lost++;
      victim.resourcesLost += value;
      if (!cost) victim.unknownCosts++;
      if (typeof death.bornAt === "number" && death.bornAt >= 0 && death.bornAt <= death.time) victim.lifespan.push(death.time - death.bornAt);
      count(victim.diedTo, death.killerUnit || "Unattributed");
    } else if (death.killer === side) {
      const killer = row(death.killerUnit || "Unattributed");
      killer.kills++;
      killer.resourcesKilled += value;
      if (!cost) killer.unknownCosts++;
      count(killer.killed, death.name);
    }
  }
  return [...rows.values()].map(value => {
    const sorted = value.lifespan.sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    const median = sorted.length ? (sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null;
    const ratio = value.resourcesLost > 0 && value.unknownCosts === 0 ? value.resourcesKilled / value.resourcesLost : null;
    return { ...value, median, ratio };
  }).sort((a, b) => b.lost + b.kills - a.lost - a.kills || a.name.localeCompare(b.name));
}

import type { PatchEra } from "@/lib/meta";
import { getUnitCost } from "@/lib/sc2-units";
import { profileIdForEra, resolveProfile } from "@/lib/sc2-patch/profiles";
import { canonicalizeName } from "./compositionAt";

export interface CasualtyResourceCost {
  minerals: number;
  gas: number;
}

// The roster canonicalizer covers combat stances; these are the remaining
// structure aliases. WarpGate stays distinct because some patch profiles
// charge minerals/gas to transform an existing Gateway.
const STRUCTURE_ALIASES = new Map([
  ["TemplarArchive", "TemplarArchives"],
  ["LurkerDenMP", "LurkerDen"],
  ["RefineryRich", "Refinery"],
  ["AssimilatorRich", "Assimilator"],
  ["ExtractorRich", "Extractor"],
  ["TechLab", "BarracksTechLab"],
  ["Reactor", "BarracksReactor"],
]);

interface CostTable {
  get(name: string, seen?: Set<string>): Readonly<CasualtyResourceCost> | null;
}
const costTables = new Map<string, CostTable>();

function buildCostTable(era?: PatchEra | null): CostTable {
  const profile = resolveProfile(profileIdForEra(era));
  const cache = new Map<string, Readonly<CasualtyResourceCost> | null>();
  const get: CostTable["get"] = (name, seen = new Set()) => {
    const alias = canonicalizeName(name);
    // Canonicalization is shared with the roster's object-backed alias map;
    // an unknown name matching an Object prototype member is still unknown.
    const normalized = typeof alias === "string" ? alias : name;
    const canonical = STRUCTURE_ALIASES.get(normalized) ?? normalized;
    if (cache.has(canonical)) return cache.get(canonical)!;
    if (seen.has(canonical)) return null;
    seen.add(canonical);

    const def = Object.prototype.hasOwnProperty.call(profile.units, canonical)
      ? profile.units[canonical] : undefined;
    let cost: CasualtyResourceCost | null = null;
    if (canonical === "WarpGate") {
      const gateway = get("Gateway", seen);
      const transform = profile.mechanics.warpgate.transformCost;
      if (gateway) cost = {
        minerals: gateway.minerals + transform.minerals,
        gas: gateway.gas + transform.gas,
      };
    } else if (def) {
      cost = { minerals: def.minerals, gas: def.gas };
      // A morph loses both its upgrade and the unit it consumed. Only
      // worker-built Zerg structures consume their producer: adding every
      // builtFrom producer would also charge a Marine for its Barracks.
      const consumed = def.morphFrom ?? (
        def.isStructure && def.race === "Zerg" && def.builtFrom.includes("Drone")
          ? "Drone" : null
      );
      if (consumed) {
        const parent = get(consumed, seen);
        cost = parent ? {
          minerals: cost.minerals + parent.minerals,
          gas: cost.gas + parent.gas,
        } : null;
      }
    } else {
      // Reuse catalog supplements (SensorTower, NydusCanal, Hellbat,
      // Mothership). Archon uses its existing two-High-Templar estimate;
      // the casualty payload does not identify the merged templar pair.
      const extra = getUnitCost(canonical, era);
      if (extra && Number.isFinite(extra.m) && Number.isFinite(extra.g)) {
        cost = { minerals: extra.m, gas: extra.g };
      }
    }
    cache.set(canonical, cost);
    return cost;
  };
  return { get };
}

/** Full invested mineral/gas cost, including consumed morph parents and
 * the Drone spent on Zerg construction exactly once. These are nominal
 * investments: the death ledger contains no construction progress/refunds.
 * Unknown types return null so totals can disclose missing prices. */
export function casualtyCost(
  name: string,
  era?: PatchEra | null,
): Readonly<CasualtyResourceCost> | null {
  const profileId = profileIdForEra(era);
  let table = costTables.get(profileId);
  if (!table) {
    table = buildCostTable(era);
    costTables.set(profileId, table);
  }
  return table.get(name);
}

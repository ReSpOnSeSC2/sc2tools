/**
 * Threat catalog: shipped JSON + a user overlay.
 *
 * The shipped catalog (data/threats/*.json) is the curated, patch-
 * accurate baseline. User edits — tweaked timings, disabled entries,
 * brand-new threats — live in an overlay object persisted to
 * localStorage by the UI (via useLocalStorageState), merged here.
 * "Reset to defaults" is just deleting the overlay.
 */
import protossThreats from "../data/threats/protoss-threats.json";
import terranThreats from "../data/threats/terran-threats.json";
import zergThreats from "../data/threats/zerg-threats.json";
import type { SimRace, Threat } from "../types";

export const THREAT_OVERLAY_STORAGE_KEY = "optimizer.threats.v1";

export interface ThreatOverlay {
  version: 1;
  /** Full replacement entries keyed by threat id. */
  overrides: Record<string, Threat>;
  /** Threat ids hidden from the catalog. */
  disabled: string[];
  /** User-created threats. */
  added: Threat[];
}

export function emptyOverlay(): ThreatOverlay {
  return { version: 1, overrides: {}, disabled: [], added: [] };
}

export function isThreatOverlay(raw: unknown): raw is ThreatOverlay {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Partial<ThreatOverlay>;
  return (
    o.version === 1 &&
    typeof o.overrides === "object" &&
    o.overrides !== null &&
    Array.isArray(o.disabled) &&
    Array.isArray(o.added)
  );
}

function shippedThreats(): Threat[] {
  return [
    ...(zergThreats.threats as Threat[]),
    ...(terranThreats.threats as Threat[]),
    ...(protossThreats.threats as Threat[]),
  ];
}

/** Full catalog with the user overlay applied. */
export function threatCatalog(overlay: ThreatOverlay | null): Threat[] {
  const base = shippedThreats();
  if (!overlay) return base;
  const disabled = new Set(overlay.disabled);
  const merged = base
    .filter((t) => !disabled.has(t.id))
    .map((t) => overlay.overrides[t.id] ?? t);
  const knownIds = new Set(merged.map((t) => t.id));
  for (const added of overlay.added) {
    if (!knownIds.has(added.id) && !disabled.has(added.id)) {
      merged.push(added);
    }
  }
  return merged;
}

/** Threats relevant to a matchup: attacker = vsRace, defender = race. */
export function threatsForMatchup(
  catalog: Threat[],
  race: SimRace,
  vsRace: SimRace,
): Threat[] {
  return catalog.filter(
    (t) => t.attackerRace === vsRace && t.vsDefender.includes(race),
  );
}

/** Validate a user-edited threat before persisting it. */
export function validateThreat(threat: Threat): string[] {
  const problems: string[] = [];
  if (!threat.id || !/^[a-z0-9-]+$/.test(threat.id)) {
    problems.push("id must be lowercase letters, digits, and dashes");
  }
  if (!threat.name?.trim()) problems.push("name is required");
  if (!["Protoss", "Terran", "Zerg"].includes(threat.attackerRace)) {
    problems.push("attackerRace must be Protoss, Terran, or Zerg");
  }
  if (!threat.vsDefender?.length) {
    problems.push("at least one defender race is required");
  }
  if (!(threat.earliestArrivalSec > 0)) {
    problems.push("earliest arrival must be a positive time in seconds");
  }
  if (!threat.waves?.length) {
    problems.push("at least one attack wave is required");
  } else {
    for (const wave of threat.waves) {
      if (!(wave.timeSec > 0)) problems.push("wave times must be positive");
      const units = Object.entries(wave.units ?? {});
      if (units.length === 0) problems.push("each wave needs units");
      if (units.some(([, n]) => !(n > 0))) {
        problems.push("wave unit counts must be positive");
      }
    }
  }
  if (
    !(threat.priorProbability >= 0.01 && threat.priorProbability <= 0.99)
  ) {
    problems.push("prior probability must be between 0.01 and 0.99");
  }
  return problems;
}

/** Apply an edit to the overlay (immutable update for React state). */
export function upsertThreat(
  overlay: ThreatOverlay,
  threat: Threat,
  isShippedId: boolean,
): ThreatOverlay {
  if (isShippedId) {
    return {
      ...overlay,
      overrides: { ...overlay.overrides, [threat.id]: threat },
      disabled: overlay.disabled.filter((id) => id !== threat.id),
    };
  }
  return {
    ...overlay,
    added: [
      ...overlay.added.filter((t) => t.id !== threat.id),
      threat,
    ],
    disabled: overlay.disabled.filter((id) => id !== threat.id),
  };
}

export function setThreatDisabled(
  overlay: ThreatOverlay,
  threatId: string,
  disabled: boolean,
): ThreatOverlay {
  const without = overlay.disabled.filter((id) => id !== threatId);
  return {
    ...overlay,
    disabled: disabled ? [...without, threatId] : without,
  };
}

/** Ids of threats that ship with the app (used by the editor UI). */
export function shippedThreatIds(): Set<string> {
  return new Set(shippedThreats().map((t) => t.id));
}

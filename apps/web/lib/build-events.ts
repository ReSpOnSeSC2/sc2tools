/**
 * Build-event normalization for the BuildOrderTimeline component.
 *
 * Translates the per-game API event shape (returned by
 * /v1/games/:id/build-order) into display-ready rows the timeline
 * can render. Resolves SC2 icons through lib/sc2-icons and computes
 * the `signature` array shape consumed by /v1/custom-builds.
 *
 * The keyword fallback mirrors the analyzer overlay's
 * `KEYWORDS` map (icon-registry.js) so a custom event name like
 * "CommandCenter" or "Command Center" resolves to the right icon.
 */
import {
  AVAILABLE_ICONS,
  ICON_BASE,
  getIconPath,
  normalizeIconName,
  type IconKind,
} from "@/lib/sc2-icons";

/** Raw event shape returned by the API. */
export interface BuildOrderEvent {
  time: number;
  time_display?: string;
  name: string;
  display?: string;
  race?: string;
  category?: string;
  tier?: number;
  is_building?: boolean;
}

export type BuildEventCategory = "unit" | "building" | "upgrade" | "other";

/** Per-row display data the timeline renders. */
export interface BuildEventRow {
  /** Stable key for React lists. */
  key: string;
  time: number;
  timeDisplay: string;
  /** Original raw name from the build log (used for tooltips). */
  rawName: string;
  /** Friendly label, "Spawning Pool" instead of "SpawningPool". */
  displayName: string;
  category: BuildEventCategory;
  /** Resolved /icons/sc2/... URL or null when no icon is available. */
  iconName: string | null;
  iconPath: string | null;
  iconKind: IconKind | null;
  race?: string;
  supply?: number;
}

const NAME_KEYWORDS: ReadonlyArray<{
  kw: string;
  name: string;
  kind: IconKind;
}> = [
  // Buildings — Zerg
  { kw: "spawningpool", name: "spawningpool", kind: "building" },
  { kw: "spawning pool", name: "spawningpool", kind: "building" },
  { kw: "pool", name: "spawningpool", kind: "building" },
  { kw: "banelingnest", name: "banelingnest", kind: "building" },
  { kw: "baneling nest", name: "banelingnest", kind: "building" },
  { kw: "roachwarren", name: "roachwarren", kind: "building" },
  { kw: "roach warren", name: "roachwarren", kind: "building" },
  { kw: "hydraliskden", name: "hydraliskden", kind: "building" },
  { kw: "hydralisk den", name: "hydraliskden", kind: "building" },
  { kw: "lurkerden", name: "lurkerden", kind: "building" },
  { kw: "spire", name: "spire", kind: "building" },
  { kw: "nydus", name: "nydusnetwork", kind: "building" },
  { kw: "hatchery", name: "hatchery", kind: "building" },
  { kw: "hatch", name: "hatchery", kind: "building" },
  { kw: "lair", name: "lair", kind: "building" },
  { kw: "hive", name: "hive", kind: "building" },
  { kw: "evolutionchamber", name: "evolutionchamber", kind: "building" },
  { kw: "extractor", name: "extractor", kind: "building" },
  { kw: "infestationpit", name: "infestationpit", kind: "building" },
  { kw: "ultraliskcavern", name: "ultraliskcavern", kind: "building" },
  // Buildings — Protoss
  { kw: "gateway", name: "gateway", kind: "building" },
  { kw: "warpgate", name: "warpgate", kind: "building" },
  { kw: "photoncannon", name: "photoncannon", kind: "building" },
  { kw: "cannon", name: "photoncannon", kind: "building" },
  { kw: "forge", name: "forge", kind: "building" },
  { kw: "cyberneticscore", name: "cyberneticscore", kind: "building" },
  { kw: "twilightcouncil", name: "twilightcouncil", kind: "building" },
  { kw: "twilight", name: "twilightcouncil", kind: "building" },
  { kw: "roboticsfacility", name: "roboticsfacility", kind: "building" },
  { kw: "robo", name: "roboticsfacility", kind: "building" },
  { kw: "roboticsbay", name: "roboticsbay", kind: "building" },
  { kw: "stargate", name: "stargate", kind: "building" },
  { kw: "fleetbeacon", name: "fleetbeacon", kind: "building" },
  { kw: "darkshrine", name: "darkshrine", kind: "building" },
  { kw: "templararchive", name: "templararchive", kind: "building" },
  { kw: "nexus", name: "nexus", kind: "building" },
  { kw: "assimilator", name: "assimilator", kind: "building" },
  { kw: "shieldbattery", name: "shieldbattery", kind: "building" },
  { kw: "pylon", name: "pylon", kind: "building" },
  // Buildings — Terran
  { kw: "commandcenter", name: "commandcenter", kind: "building" },
  { kw: "orbitalcommand", name: "orbitalcommand", kind: "building" },
  { kw: "orbital", name: "orbitalcommand", kind: "building" },
  { kw: "planetary", name: "planetaryfortress", kind: "building" },
  { kw: "barracks", name: "barracks", kind: "building" },
  { kw: "rax", name: "barracks", kind: "building" },
  { kw: "factory", name: "factory", kind: "building" },
  { kw: "starport", name: "starport", kind: "building" },
  { kw: "engineeringbay", name: "engineeringbay", kind: "building" },
  { kw: "armory", name: "armory", kind: "building" },
  { kw: "fusioncore", name: "fusioncore", kind: "building" },
  { kw: "ghostacademy", name: "ghostacademy", kind: "building" },
  { kw: "missileturret", name: "missileturret", kind: "building" },
  { kw: "turret", name: "missileturret", kind: "building" },
  { kw: "bunker", name: "bunker", kind: "building" },
  { kw: "refinery", name: "refinery", kind: "building" },
  { kw: "supplydepot", name: "supplydepot", kind: "building" },
  // Units — Zerg
  { kw: "zergling", name: "zergling", kind: "unit" },
  { kw: "speedling", name: "zergling", kind: "unit" },
  { kw: "ling", name: "zergling", kind: "unit" },
  { kw: "baneling", name: "baneling", kind: "unit" },
  { kw: "bane", name: "baneling", kind: "unit" },
  { kw: "queen", name: "queen", kind: "unit" },
  { kw: "roach", name: "roach", kind: "unit" },
  { kw: "ravager", name: "ravager", kind: "unit" },
  { kw: "overseer", name: "overseer", kind: "unit" },
  { kw: "hydralisk", name: "hydralisk", kind: "unit" },
  { kw: "hydra", name: "hydralisk", kind: "unit" },
  { kw: "lurker", name: "lurker", kind: "unit" },
  { kw: "mutalisk", name: "mutalisk", kind: "unit" },
  { kw: "muta", name: "mutalisk", kind: "unit" },
  { kw: "corruptor", name: "corruptor", kind: "unit" },
  { kw: "broodlord", name: "broodlord", kind: "unit" },
  { kw: "infestor", name: "infestor", kind: "unit" },
  { kw: "swarmhost", name: "swarmhost", kind: "unit" },
  { kw: "viper", name: "viper", kind: "unit" },
  { kw: "ultralisk", name: "ultralisk", kind: "unit" },
  { kw: "ultra", name: "ultralisk", kind: "unit" },
  { kw: "drone", name: "drone", kind: "unit" },
  { kw: "overlord", name: "overlord", kind: "unit" },
  // Units — Protoss
  { kw: "zealot", name: "zealot", kind: "unit" },
  { kw: "chargelot", name: "zealot", kind: "unit" },
  { kw: "stalker", name: "stalker", kind: "unit" },
  { kw: "sentry", name: "sentry", kind: "unit" },
  { kw: "adept", name: "adept", kind: "unit" },
  { kw: "hightemplar", name: "hightemplar", kind: "unit" },
  { kw: "high templar", name: "hightemplar", kind: "unit" },
  { kw: "darktemplar", name: "darktemplar", kind: "unit" },
  { kw: "dark templar", name: "darktemplar", kind: "unit" },
  { kw: "archon", name: "archon", kind: "unit" },
  { kw: "observer", name: "observer", kind: "unit" },
  { kw: "immortal", name: "immortal", kind: "unit" },
  { kw: "colossus", name: "colossus", kind: "unit" },
  { kw: "disruptor", name: "disruptor", kind: "unit" },
  { kw: "warpprism", name: "warpprism", kind: "unit" },
  { kw: "warp prism", name: "warpprism", kind: "unit" },
  { kw: "phoenix", name: "phoenix", kind: "unit" },
  { kw: "oracle", name: "oracle", kind: "unit" },
  { kw: "voidray", name: "voidray", kind: "unit" },
  { kw: "void ray", name: "voidray", kind: "unit" },
  { kw: "tempest", name: "tempest", kind: "unit" },
  { kw: "carrier", name: "carrier", kind: "unit" },
  { kw: "mothership", name: "mothership", kind: "unit" },
  { kw: "probe", name: "probe", kind: "unit" },
  // Units — Terran
  { kw: "marauder", name: "marauder", kind: "unit" },
  { kw: "marine", name: "marine", kind: "unit" },
  { kw: "reaper", name: "reaper", kind: "unit" },
  { kw: "ghost", name: "ghost", kind: "unit" },
  { kw: "hellbat", name: "hellbat", kind: "unit" },
  { kw: "hellion", name: "hellion", kind: "unit" },
  { kw: "widowmine", name: "widowmine", kind: "unit" },
  { kw: "widow mine", name: "widowmine", kind: "unit" },
  { kw: "siegetank", name: "siegetank", kind: "unit" },
  { kw: "siege tank", name: "siegetank", kind: "unit" },
  { kw: "tank", name: "siegetank", kind: "unit" },
  { kw: "cyclone", name: "cyclone", kind: "unit" },
  { kw: "thor", name: "thor", kind: "unit" },
  { kw: "viking", name: "viking", kind: "unit" },
  { kw: "medivac", name: "medivac", kind: "unit" },
  { kw: "liberator", name: "liberator", kind: "unit" },
  { kw: "banshee", name: "banshee", kind: "unit" },
  { kw: "raven", name: "raven", kind: "unit" },
  { kw: "battlecruiser", name: "battlecruiser", kind: "unit" },
  { kw: "scv", name: "scv", kind: "unit" },
  // Upgrades
  { kw: "blink", name: "blink", kind: "upgrade" },
  { kw: "charge", name: "charge", kind: "upgrade" },
  { kw: "glaive", name: "glaive", kind: "upgrade" },
  { kw: "speed", name: "speed", kind: "upgrade" },
  { kw: "cloak", name: "cloak", kind: "upgrade" },
  { kw: "stim", name: "stim", kind: "upgrade" },
  { kw: "concussive", name: "concussive", kind: "upgrade" },
  { kw: "combat shield", name: "combatshield", kind: "upgrade" },
  { kw: "combatshield", name: "combatshield", kind: "upgrade" },
];

const KIND_TO_CATEGORY: Record<IconKind, BuildEventCategory> = {
  building: "building",
  unit: "unit",
  upgrade: "upgrade",
  race: "other",
  league: "other",
};

interface NameMatch {
  iconName: string;
  iconKind: IconKind;
}

function inferKindFromPath(path: string): IconKind | null {
  if (path.includes("/buildings/")) return "building";
  if (path.includes("/units/")) return "unit";
  if (path.includes("/upgrades/")) return "upgrade";
  if (path.includes("/races/")) return "race";
  if (path.includes("/leagues/")) return "league";
  return null;
}

/**
 * Resolve a free-form event name (camelCase, spaced, with prefixes)
 * to the canonical icon name + kind. Returns null when nothing in
 * the keyword list matches and the normalized name isn't a known
 * icon key on its own.
 */
function matchName(rawName: string): NameMatch | null {
  if (!rawName) return null;
  const normalized = normalizeIconName(rawName);
  const direct = getIconPath(normalized);
  if (direct) {
    const kind = inferKindFromPath(direct);
    if (kind) return { iconName: normalized, iconKind: kind };
  }
  const haystack = rawName.toLowerCase();
  for (const entry of NAME_KEYWORDS) {
    if (haystack.indexOf(entry.kw) === -1) continue;
    const rel = `${kindDir(entry.kind)}/${entry.name}.png`;
    if (!AVAILABLE_ICONS.has(rel)) continue;
    return { iconName: entry.name, iconKind: entry.kind };
  }
  return null;
}

function kindDir(kind: IconKind): string {
  switch (kind) {
    case "building":
      return "buildings";
    case "unit":
      return "units";
    case "upgrade":
      return "upgrades";
    case "race":
      return "races";
    case "league":
      return "leagues";
  }
}

/**
 * Convert a build-log raw name into the spaced human display form
 * we want shown in the timeline. "CommandCenter" → "Command Center",
 * "spawning_pool" → "Spawning Pool". When the API already provided
 * a `display` value we prefer that.
 */
export function humanizeBuildName(name: string): string {
  if (!name) return "";
  const cleaned = name.replace(/[_\-]+/g, " ").trim();
  // Insert spaces between camelCase boundaries.
  const spaced = cleaned.replace(
    /([a-z0-9])([A-Z])/g,
    (_m, a: string, b: string) => `${a} ${b}`,
  );
  return spaced
    .split(/\s+/)
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** Format seconds into "m:ss". */
export function formatBuildTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function categoryFromMatch(match: NameMatch | null, hint?: string): BuildEventCategory {
  if (match) return KIND_TO_CATEGORY[match.iconKind];
  const lower = (hint || "").toLowerCase();
  if (lower === "unit") return "unit";
  if (lower === "building") return "building";
  if (lower === "upgrade") return "upgrade";
  return "other";
}

/** Lightweight name-only resolution for surfaces that don't have a
 *  full event object (e.g. build editors, strategy chips). */
export interface NormalizedBuildName {
  iconName: string | null;
  iconKind: IconKind | null;
  iconPath: string | null;
  displayName: string;
  category: BuildEventCategory;
}

/** Resolve a free-form build entity name into icon + display + category. */
export function normalizeBuildName(name: string): NormalizedBuildName {
  const raw = String(name || "").trim();
  const match = matchName(raw);
  const displayName = humanizeBuildName(raw) || raw;
  const category = categoryFromMatch(match);
  return {
    iconName: match ? match.iconName : null,
    iconKind: match ? match.iconKind : null,
    iconPath: match
      ? `${ICON_BASE}/${kindDir(match.iconKind)}/${match.iconName}.png`
      : null,
    displayName,
    category,
  };
}

/**
 * Normalize a single API build-event into a display row. Always
 * returns a row — when no icon matches, `iconPath` is null and the
 * row falls back to a text label in the UI.
 */
export function normalizeBuildEvent(
  event: BuildOrderEvent,
  index: number,
): BuildEventRow {
  const rawName = String(event?.name || "").trim();
  const apiDisplay = (event?.display || "").trim();
  const match = matchName(rawName);
  const displayName = apiDisplay || humanizeBuildName(rawName) || rawName;
  const time = Number.isFinite(event?.time) ? Number(event.time) : 0;
  const apiCategory = event?.category;
  const category =
    apiCategory === "upgrade"
      ? "upgrade"
      : event?.is_building
        ? "building"
        : categoryFromMatch(match, apiCategory);
  const iconKind = match ? match.iconKind : null;
  const iconName = match ? match.iconName : null;
  const iconPath = match
    ? `${ICON_BASE}/${kindDir(match.iconKind)}/${match.iconName}.png`
    : null;
  return {
    key: `${index}-${time}-${rawName}`,
    time,
    timeDisplay: event?.time_display || formatBuildTime(time),
    rawName,
    displayName,
    category,
    iconName,
    iconKind,
    iconPath,
    race: event?.race,
  };
}

/**
 * Convert a list of API events into normalized rows. Filters out
 * entries with empty names so rendering never produces blank rows.
 */
export function normalizeBuildEvents(
  events: ReadonlyArray<BuildOrderEvent> | null | undefined,
): BuildEventRow[] {
  if (!events) return [];
  const rows: BuildEventRow[] = [];
  events.forEach((event, index) => {
    if (!event || !event.name) return;
    rows.push(normalizeBuildEvent(event, index));
  });
  return rows;
}

/** Item in the `signature` array sent to /v1/custom-builds. */
export interface BuildSignatureItem {
  unit: string;
  count: number;
  beforeSec: number;
}

/**
 * Compress a normalized row list into the `signature` shape consumed
 * by /v1/custom-builds: one entry per (unit, beforeSec=earliest-time)
 * with a running count. Keeps order stable so the UI can preview the
 * payload before saving.
 */
export function eventsToSignature(
  rows: ReadonlyArray<BuildEventRow>,
  options: { maxItems?: number } = {},
): BuildSignatureItem[] {
  const max = options.maxItems ?? 200;
  const order: string[] = [];
  const acc = new Map<string, BuildSignatureItem>();
  for (const row of rows) {
    const unit = row.iconName || normalizeIconName(row.rawName) || row.rawName;
    if (!unit) continue;
    const sanitized = unit.slice(0, 80);
    const existing = acc.get(sanitized);
    if (existing) {
      existing.count = Math.min(existing.count + 1, 200);
      if (row.time < existing.beforeSec) existing.beforeSec = row.time;
      continue;
    }
    if (order.length >= max) continue;
    order.push(sanitized);
    acc.set(sanitized, {
      unit: sanitized,
      count: 1,
      beforeSec: Math.max(0, Math.round(row.time)),
    });
  }
  return order.map((k) => acc.get(k)!).filter(Boolean);
}

/**
 * Convert the persisted `signature` shape (one entry per unit with a
 * count and a "before this time" timestamp) back into display rows.
 * Used by the community build detail page where the timeline reads a
 * compressed signature instead of full per-instance events.
 *
 * Each signature entry yields one row. The count surfaces as a "×N"
 * note so a single line still expresses the "12 zerglings before
 * 4:00" shape.
 */
export function signatureToRows(
  signature: ReadonlyArray<BuildSignatureItem> | null | undefined,
): BuildEventRow[] {
  if (!signature || signature.length === 0) return [];
  const rows: BuildEventRow[] = [];
  signature.forEach((item, index) => {
    const rawName = String(item?.unit || "").trim();
    if (!rawName) return;
    const match = matchName(rawName);
    const displayName = humanizeBuildName(rawName) || rawName;
    const category = categoryFromMatch(match);
    const time = Number.isFinite(item.beforeSec)
      ? Math.max(0, Number(item.beforeSec))
      : 0;
    rows.push({
      key: `sig-${index}-${rawName}`,
      time,
      timeDisplay: formatBuildTime(time),
      rawName,
      displayName,
      category,
      iconName: match ? match.iconName : null,
      iconKind: match ? match.iconKind : null,
      iconPath: match
        ? `${ICON_BASE}/${kindDir(match.iconKind)}/${match.iconName}.png`
        : null,
    });
  });
  return rows;
}

/**
 * v3 rule shape persisted by the modern BuildEditorModal — kept loose
 * here because the community detail page reads validated docs from the
 * server and we just need the fields we surface.
 */
export interface BuildRuleLike {
  type: string;
  name: string;
  time_lt: number;
  count?: number;
}

/**
 * Convert v3 `rules` into the same `BuildSignatureItem[]` shape the
 * existing community timeline renders. Each rule becomes one row,
 * sorted chronologically by `time_lt`. Negative `not_before`
 * constraints are dropped because the timeline is a positive-only
 * "what gets built and when" view; the timeline doesn't have a way to
 * surface "absent before T" without adding new visual language.
 *
 * Used by the community build detail page so builds saved through the
 * v3 editor (which writes `rules` instead of `signature`) still render
 * a structured build order rather than the empty-state fallback.
 */
export function rulesToSignature(
  rules: ReadonlyArray<BuildRuleLike> | null | undefined,
): BuildSignatureItem[] {
  if (!rules || rules.length === 0) return [];
  const items: BuildSignatureItem[] = [];
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const name = String(r.name || "").trim();
    if (!name) continue;
    if (r.type === "not_before") continue;
    const isCount =
      r.type === "count_min" ||
      r.type === "count_max" ||
      r.type === "count_exact";
    const count = isCount
      ? Math.max(1, Math.min(200, Math.floor(Number(r.count) || 1)))
      : 1;
    items.push({
      unit: name,
      count,
      beforeSec: Math.max(0, Math.floor(Number(r.time_lt) || 0)),
    });
  }
  items.sort((a, b) => a.beforeSec - b.beforeSec);
  return items;
}

/** Slugify a free-form name into the slug pattern accepted by the API. */
export function slugifyBuildName(name: string): string {
  const trimmed = (name || "").trim().toLowerCase();
  if (!trimmed) return "";
  const slug = trimmed
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "custom-build";
}

/** Coverage helper used in tests / dev tooling. */
export function buildEventIconCoverage(rows: ReadonlyArray<BuildEventRow>): {
  total: number;
  iconHits: number;
} {
  const total = rows.length;
  const iconHits = rows.reduce((acc, r) => acc + (r.iconPath ? 1 : 0), 0);
  return { total, iconHits };
}

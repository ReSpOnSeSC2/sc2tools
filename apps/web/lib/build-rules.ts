/**
 * build-rules — Rule schema, helpers, and event mapping for the cloud
 * BuildEditor (parity port of SPA build-editor-helpers.js, schema v3).
 *
 * Exposes:
 *   - SPA event → server-canonical token (`spaEventToWhat`)
 *   - Pure-row construction for the source-replay column
 *   - Rule constructors, type cycler, time/count clamps + parsers
 *   - Default-name + slug helpers
 *   - Draft sanitiser ({ ok, errors, payload })
 *   - Tech-token highlighter
 *
 * NOTE: This module is framework-agnostic — no React imports — so the
 * same helpers can be reused by the (future) backend rules evaluator
 * and unit-tested directly.
 */
import type { BuildOrderEvent } from "@/lib/build-events";

export const BUILD_RULES_SCHEMA_VERSION = 3 as const;

const SIG_TOKEN_REGEX = /^[A-Za-z][A-Za-z0-9]*$/;
const SIG_VERB_REGEX = /^(Build|Train|Research|Morph)\s+([A-Za-z][A-Za-z0-9]*)$/;
const SIG_PREFIXED_REGEX =
  /^(Build|Train|Research|Morph)[A-Z][A-Za-z0-9]*$/;
const ZERG_UNIT_MORPHS =
  /^(Baneling|Ravager|Lurker|LurkerMP|BroodLord|Overseer)$/;
const NOISE_RE = /^(Beacon|Reward|Spray)/;

export const TIME_LT_MIN = 1;
export const TIME_LT_MAX = 1800;
export const COUNT_MIN = 0;
export const COUNT_MAX = 200;
export const DESC_MAX_CHARS = 500;
export const NAME_MIN_CHARS = 3;
export const NAME_MAX_CHARS = 120;
export const STRATEGY_NOTE_MAX_CHARS = 280;
export const STRATEGY_NOTE_MAX_ITEMS = 20;
export const AUTO_PICK_TIME_BUFFER_SEC = 30;
export const RULES_MAX_PER_BUILD = 30;
export const PREVIEW_DEBOUNCE_MS = 300;
export const PREVIEW_PAGE_SIZE = 5;

export type SkillLevelId =
  | "bronze"
  | "silver"
  | "gold"
  | "platinum"
  | "diamond"
  | "master"
  | "grandmaster";

export interface SkillLevel {
  id: SkillLevelId;
  label: string;
}

export const SKILL_LEVELS: ReadonlyArray<SkillLevel> = [
  { id: "bronze", label: "Bronze" },
  { id: "silver", label: "Silver" },
  { id: "gold", label: "Gold" },
  { id: "platinum", label: "Platinum" },
  { id: "diamond", label: "Diamond" },
  { id: "master", label: "Master" },
  { id: "grandmaster", label: "Grandmaster" },
];

const SKILL_LEVEL_IDS: ReadonlySet<SkillLevelId> = new Set(
  SKILL_LEVELS.map((l) => l.id),
);

export type RuleType =
  | "before"
  | "not_before"
  | "count_max"
  | "count_exact"
  | "count_min";

export const RULE_TYPES: ReadonlyArray<RuleType> = [
  "before",
  "not_before",
  "count_max",
  "count_exact",
  "count_min",
];

export const RULE_TYPE_ICON: Record<RuleType, string> = {
  before: "✓",
  not_before: "✗",
  count_max: "≤",
  count_exact: "=",
  count_min: "≥",
};

export const RULE_TYPE_LABEL: Record<RuleType, string> = {
  before: "built by",
  not_before: "NOT by",
  count_max: "",
  count_exact: "",
  count_min: "",
};

/** Tone hint for renderers (drives badge color in BuildEditorRules). */
export type RuleTypeTone = "win" | "loss" | "neutral";

export const RULE_TYPE_TONE: Record<RuleType, RuleTypeTone> = {
  before: "win",
  not_before: "loss",
  count_max: "neutral",
  count_exact: "neutral",
  count_min: "neutral",
};

export interface BuildRuleBase {
  name: string;
  time_lt: number;
}
export interface BuildRuleBefore extends BuildRuleBase {
  type: "before";
}
export interface BuildRuleNotBefore extends BuildRuleBase {
  type: "not_before";
}
export interface BuildRuleCountMax extends BuildRuleBase {
  type: "count_max";
  count: number;
}
export interface BuildRuleCountExact extends BuildRuleBase {
  type: "count_exact";
  count: number;
}
export interface BuildRuleCountMin extends BuildRuleBase {
  type: "count_min";
  count: number;
}
export type BuildRule =
  | BuildRuleBefore
  | BuildRuleNotBefore
  | BuildRuleCountMax
  | BuildRuleCountExact
  | BuildRuleCountMin;

export type RaceLite = "Protoss" | "Terran" | "Zerg" | "Random";
export type VsRaceLite = RaceLite | "Any";

export interface BuildEditorDraft {
  name: string;
  description: string;
  race: RaceLite;
  vsRace: VsRaceLite;
  skillLevel: SkillLevelId | null;
  shareWithCommunity: boolean;
  winConditions: string[];
  losesTo: string[];
  transitionsInto: string[];
  rules: BuildRule[];
  sourceReplayId?: string;
}

export interface BuildEditorErrors {
  name?: string;
  rules?: string;
}

export interface SanitisedDraft {
  ok: boolean;
  errors: BuildEditorErrors;
  payload: {
    name: string;
    description: string;
    race: RaceLite;
    vsRace: VsRaceLite;
    skillLevel: SkillLevelId | null;
    shareWithCommunity: boolean;
    winConditions: string[];
    losesTo: string[];
    transitionsInto: string[];
    rules: BuildRule[];
    sourceReplayId: string | null;
  };
}

/** Source-replay row shape consumed by BuildEditorRules. */
export interface SourceTimelineRow {
  key: string;
  t: number;
  what: string;
  display: string;
  timeDisplay: string;
  race: string;
  category: string;
  isBuilding: boolean;
  isTech: boolean;
}

/* ------------------------------------------------------------------ */
/* Event → token mapping                                              */
/* ------------------------------------------------------------------ */

interface EventLike {
  time: number;
  name: string;
  display?: string;
  time_display?: string;
  race?: string;
  category?: string;
  is_building?: boolean;
}

export function spaEventToWhat(ev: EventLike | null | undefined): string | null {
  if (!ev) return null;
  const raw = String(ev.name == null ? "" : ev.name).trim();
  if (!raw) return null;
  if (NOISE_RE.test(raw)) return null;
  const m = SIG_VERB_REGEX.exec(raw);
  if (m) return m[1] + m[2];
  if (SIG_PREFIXED_REGEX.test(raw)) return raw;
  const noun = raw.replace(/[^A-Za-z0-9]/g, "");
  if (!noun || !/^[A-Za-z]/.test(noun)) return null;
  if (ev.is_building) return "Build" + noun;
  if (ev.category === "upgrade") return "Research" + noun;
  if (
    ev.race === "Zerg" &&
    ev.category === "unit" &&
    ZERG_UNIT_MORPHS.test(noun)
  ) {
    return "Morph" + noun;
  }
  return "Build" + noun;
}

export function eventsToSourceRows(
  events: ReadonlyArray<BuildOrderEvent> | null | undefined,
): SourceTimelineRow[] {
  if (!events) return [];
  const out: SourceTimelineRow[] = [];
  events.forEach((ev, idx) => {
    const what = spaEventToWhat(ev);
    if (!what || !SIG_TOKEN_REGEX.test(what) || what.length > 80) return;
    const t = clampRuleTime(Number(ev.time) || 0);
    out.push({
      key: `t${t}:${what}:${idx}`,
      t,
      what,
      display: ev.display || ev.name || what,
      timeDisplay: ev.time_display || formatTime(t),
      race: ev.race || "Neutral",
      category: ev.category || "unknown",
      isBuilding: !!ev.is_building,
      isTech: isTechToken(what),
    });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Rule constructors                                                  */
/* ------------------------------------------------------------------ */

export function defaultRuleFor(
  type: RuleType,
  name: string,
  timeLt: number,
  prevCount?: number,
): BuildRule {
  const t = clampRuleTime(timeLt || 1);
  const c = clampCount(prevCount == null ? 1 : prevCount);
  if (type === "count_max") return { type, name, count: c, time_lt: t };
  if (type === "count_exact") return { type, name, count: c, time_lt: t };
  if (type === "count_min")
    return { type, name, count: c < 1 ? 1 : c, time_lt: t };
  if (type === "not_before") return { type, name, time_lt: t };
  return { type: "before", name, time_lt: t };
}

export function cycleRuleType(rule: BuildRule): BuildRule {
  const idx = RULE_TYPES.indexOf(rule.type);
  const next = RULE_TYPES[(idx + 1) % RULE_TYPES.length];
  return defaultRuleFor(
    next,
    rule.name,
    rule.time_lt,
    isCountRule(rule) ? rule.count : 1,
  );
}

export function ruleFromEvent(ev: EventLike): BuildRule | null {
  const what = spaEventToWhat(ev);
  if (!what) return null;
  const t = clampRuleTime((Number(ev.time) || 0) + AUTO_PICK_TIME_BUFFER_SEC);
  return { type: "before", name: what, time_lt: t };
}

export function isCountRule(
  r: BuildRule,
): r is BuildRuleCountMax | BuildRuleCountExact | BuildRuleCountMin {
  return (
    r.type === "count_max" || r.type === "count_exact" || r.type === "count_min"
  );
}

/* ------------------------------------------------------------------ */
/* Numeric clamps + time parsing                                      */
/* ------------------------------------------------------------------ */

export function clampRuleTime(t: number | string | null | undefined): number {
  const n = Math.round(Number(t) || 0);
  if (n < TIME_LT_MIN) return TIME_LT_MIN;
  if (n > TIME_LT_MAX) return TIME_LT_MAX;
  return n;
}

export function clampCount(c: number | string | null | undefined): number {
  const n = Math.round(Number(c) || 0);
  if (n < COUNT_MIN) return COUNT_MIN;
  if (n > COUNT_MAX) return COUNT_MAX;
  return n;
}

export function formatTime(t: number): string {
  const sec = Math.max(0, Math.round(Number(t) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? "0" + s : "" + s}`;
}

/**
 * Parse the inline time-edit input. Accepts:
 *   "3:30" -> 210
 *   "3m30" -> 210
 *   "210"  -> 210
 *   "3"    -> 180 (small ints with no separator are treated as minutes)
 */
export function parseTimeInput(input: string | null | undefined): number | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const m = s.match(/^(\d+)\s*(?:[:m]\s*(\d+))?$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] != null ? parseInt(m[2], 10) : null;
  if (b == null) {
    if (a <= 30 && !s.includes(":") && !s.toLowerCase().includes("m")) {
      return a * 60;
    }
    return a;
  }
  return a * 60 + b;
}

/* ------------------------------------------------------------------ */
/* Naming                                                             */
/* ------------------------------------------------------------------ */

export interface DefaultNameContext {
  myBuild?: string;
  myRace?: string;
  oppRace?: string;
  perspective?: "you" | "opponent";
}

export function deriveDefaultName(ctx: DefaultNameContext | null): string {
  if (!ctx) return "Custom build";
  const myBuild = String(ctx.myBuild || "").trim();
  if (ctx.perspective !== "opponent" && myBuild) return myBuild;
  const my = String(ctx.myRace || "").trim();
  const opp = String(ctx.oppRace || "").trim();
  if (my && opp) {
    const ownerPrefix =
      ctx.perspective === "opponent"
        ? `Opp ${opp}`
        : `${my.charAt(0).toUpperCase()}v${opp.charAt(0).toUpperCase()}`;
    return `${ownerPrefix} — Custom`;
  }
  return "Custom build";
}

export function slugifyRuleName(name: string): string {
  let base = String(name == null ? "" : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 78);
  if (base.length < 3) base = (base || "custom") + "-build";
  if (!/^[a-z0-9]/.test(base)) base = "b-" + base;
  if (!/[a-z0-9]$/.test(base)) base = base + "-x";
  return base.slice(0, 80);
}

/* ------------------------------------------------------------------ */
/* Draft sanitisation                                                 */
/* ------------------------------------------------------------------ */

export function sanitiseDraft(draft: BuildEditorDraft): SanitisedDraft {
  const errors: BuildEditorErrors = {};
  const name = String(draft.name || "").trim();
  if (name.length < NAME_MIN_CHARS) {
    errors.name = `Need at least ${NAME_MIN_CHARS} chars.`;
  } else if (name.length > NAME_MAX_CHARS) {
    errors.name = `Max ${NAME_MAX_CHARS} chars.`;
  }
  const description = String(draft.description || "").slice(0, DESC_MAX_CHARS);
  const rules = (Array.isArray(draft.rules) ? draft.rules : [])
    .map(sanitiseRule)
    .filter((r): r is BuildRule => r !== null);
  if (rules.length === 0) {
    errors.rules = "Need at least one rule.";
  } else if (rules.length > RULES_MAX_PER_BUILD) {
    errors.rules = `At most ${RULES_MAX_PER_BUILD} rules.`;
  }
  const skillLevel =
    draft.skillLevel && SKILL_LEVEL_IDS.has(draft.skillLevel)
      ? draft.skillLevel
      : null;
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    payload: {
      name,
      description,
      race: draft.race || "Protoss",
      vsRace: draft.vsRace || "Random",
      skillLevel,
      shareWithCommunity: !!draft.shareWithCommunity,
      winConditions: clipStrings(draft.winConditions),
      losesTo: clipStrings(draft.losesTo),
      transitionsInto: clipStrings(draft.transitionsInto),
      rules,
      sourceReplayId: draft.sourceReplayId || null,
    },
  };
}

export function sanitiseRule(r: BuildRule | null | undefined): BuildRule | null {
  if (!r || typeof r !== "object") return null;
  if (RULE_TYPES.indexOf(r.type) < 0) return null;
  if (typeof r.name !== "string" || !SIG_TOKEN_REGEX.test(r.name)) return null;
  const time_lt = clampRuleTime(r.time_lt);
  if (r.type === "count_max") {
    return { type: "count_max", name: r.name, count: clampCount(r.count), time_lt };
  }
  if (r.type === "count_exact") {
    return {
      type: "count_exact",
      name: r.name,
      count: clampCount(r.count),
      time_lt,
    };
  }
  if (r.type === "count_min") {
    return {
      type: "count_min",
      name: r.name,
      count: Math.max(1, clampCount(r.count || 1)),
      time_lt,
    };
  }
  if (r.type === "not_before") {
    return { type: "not_before", name: r.name, time_lt };
  }
  return { type: "before", name: r.name, time_lt };
}

function clipStrings(arr: ReadonlyArray<string> | null | undefined): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (let i = 0; i < arr.length && out.length < STRATEGY_NOTE_MAX_ITEMS; i++) {
    const s = String(arr[i] == null ? "" : arr[i]).trim();
    if (!s) continue;
    out.push(s.slice(0, STRATEGY_NOTE_MAX_CHARS));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tech-token highlighter                                             */
/* ------------------------------------------------------------------ */

const TECH_TOKENS: ReadonlySet<string> = new Set([
  // Protoss tech buildings
  "BuildCyberneticsCore",
  "BuildTwilightCouncil",
  "BuildRoboticsFacility",
  "BuildRoboticsBay",
  "BuildStargate",
  "BuildFleetBeacon",
  "BuildTemplarArchives",
  "BuildTemplarArchive",
  "BuildDarkShrine",
  // Protoss key units
  "BuildStalker",
  "BuildSentry",
  "BuildAdept",
  "BuildPhoenix",
  "BuildOracle",
  "BuildVoidRay",
  "BuildTempest",
  "BuildCarrier",
  "BuildImmortal",
  "BuildColossus",
  "BuildDisruptor",
  "BuildHighTemplar",
  "BuildDarkTemplar",
  "BuildArchon",
  "BuildMothership",
  // Terran tech buildings
  "BuildFactory",
  "BuildStarport",
  "BuildArmory",
  "BuildFusionCore",
  "BuildEngineeringBay",
  "BuildGhostAcademy",
  "BuildOrbitalCommand",
  "BuildPlanetaryFortress",
  // Terran key units
  "BuildMarauder",
  "BuildReaper",
  "BuildHellion",
  "BuildHellbat",
  "BuildSiegeTank",
  "BuildCyclone",
  "BuildThor",
  "BuildBanshee",
  "BuildVikingFighter",
  "BuildLiberator",
  "BuildRaven",
  "BuildBattlecruiser",
  "BuildGhost",
  "BuildWidowMine",
  // Zerg tech buildings + morphs
  "BuildSpawningPool",
  "BuildRoachWarren",
  "BuildBanelingNest",
  "BuildHydraliskDen",
  "BuildSpire",
  "BuildInfestationPit",
  "BuildUltraliskCavern",
  "BuildNydusNetwork",
  "MorphLair",
  "MorphHive",
  "MorphGreaterSpire",
  "MorphLurkerDen",
  // Zerg key units
  "BuildRoach",
  "BuildHydralisk",
  "BuildMutalisk",
  "BuildCorruptor",
  "BuildInfestor",
  "BuildViper",
  "BuildSwarmHost",
  "BuildUltralisk",
  "MorphBaneling",
  "MorphLurker",
  "MorphRavager",
  "MorphBroodLord",
  "MorphOverseer",
]);

export function isTechToken(token: string | null | undefined): boolean {
  if (!token) return false;
  if (TECH_TOKENS.has(token)) return true;
  if (/^Research[A-Z]/.test(token)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Race UI options                                                    */
/* ------------------------------------------------------------------ */

export const RACE_OPTIONS: ReadonlyArray<RaceLite> = [
  "Protoss",
  "Terran",
  "Zerg",
  "Random",
];

export const VS_RACE_OPTIONS: ReadonlyArray<VsRaceLite> = [
  "Protoss",
  "Terran",
  "Zerg",
  "Random",
  "Any",
];

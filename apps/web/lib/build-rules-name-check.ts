/**
 * build-rules-name-check — advisory, build-level checks shown above the
 * rules grid. Neither ever blocks saving.
 *
 *   - Name check: a build named "2 Stargate Void Ray" whose rules pass
 *     with one Stargate matches any one-Stargate game, and the cloud's
 *     ingest tagger then relabels those games with its name. The check
 *     reads "{2-9} {structure}" out of the name and compares it with the
 *     rules. Only production structures are read (no town halls, Pool or
 *     Base), the 2–9 range skips supply notation ("12 Pool",
 *     "17 Hatch 18 Gas"), upgrade notation ("2/2 Robo") is skipped, and so
 *     is a count that names the opponent's build ("vs 4 Gate", "Anti 2-Rax").
 *   - Requires nothing: every named rule only caps or forbids, so a game
 *     with none of it built passes.
 *
 * Framework-agnostic (no React).
 */
import {
  RULES_MAX_PER_BUILD,
  type BuildRule,
  type SourceTimelineRow,
} from "@/lib/build-rules";
import { humanizeRuleEntity, pluralizeEntity } from "@/lib/build-rules-copy";
import {
  ruleCountValue,
  ruleQuantifier,
  ruleTone,
} from "@/lib/build-rules-quantity";
import { raiseRuleForRepeatRow } from "@/lib/build-rules-repeat";

const NAME_COUNT_RE =
  /(?:^|[^A-Za-z0-9./])([2-9])\s*-?\s*(gates?|gateways?|stargates?|sg|robos?|robotics|rax|barracks|facts?|factory|factories|ports?|starports?)(?![A-Za-z])/gi;

/** Words before a count that make it the opponent's build, not this one. */
const OPPONENT_LEAD_RE = /\b(?:vs\.?|versus|anti)[\s-]*$/i;

/** Lower-case name alias → rule token. */
const ALIAS_TOKEN: ReadonlyMap<string, string> = new Map(
  Object.entries({
    BuildGateway: "gate gates gateway gateways",
    BuildStargate: "stargate stargates sg",
    BuildRoboticsFacility: "robo robos robotics",
    BuildBarracks: "rax barracks",
    BuildFactory: "fact facts factory factories",
    BuildStarport: "port ports starport starports",
  }).flatMap(([token, aliases]) =>
    aliases.split(" ").map((alias) => [alias, token] as const),
  ),
);

/** A structure count read out of a build name. */
export interface NameCount {
  /** The number in the name, 2–9. */
  n: number;
  /** The rule token it names, e.g. "BuildStargate". */
  token: string;
  /** The name's own words, e.g. "2 Stargate", "4-Gate", "2 SG". */
  text: string;
}

/**
 * Every "{2-9} {structure}" in a build name, in order:
 *   "PvZ - 2 Stargate Void Ray" → [{n: 2, token: "BuildStargate", text: "2 Stargate"}]
 *   "12 Pool", "1-1-1", "2 Base Colossus", "2/2 Robo", "vs 4 Gate" → []
 */
export function parseNameCounts(name: string): NameCount[] {
  const out: NameCount[] = [];
  const source = String(name || "");
  for (const m of source.matchAll(NAME_COUNT_RE)) {
    const token = ALIAS_TOKEN.get(m[2].toLowerCase());
    if (!token) continue;
    const start = (m.index ?? 0) + m[0].indexOf(m[1]);
    if (OPPONENT_LEAD_RE.test(source.slice(0, start))) continue;
    out.push({ n: Number(m[1]), token, text: m[0].slice(m[0].indexOf(m[1])) });
  }
  return out;
}

/** Dismissal key for a name count: `${token}:${n}`. */
export function nameCountKey(count: Pick<NameCount, "token" | "n">): string {
  return `${count.token}:${count.n}`;
}

/**
 * What the name check shows:
 *   - "raise": a rule exists and the "Require {n}" button can fix it by
 *     calling addRuleFromEvent(nthRow), the same raise and deadline as
 *     the timeline's "At least {n}" chip.
 *   - "manual": a rule exists but the raise is not offered (edit mode,
 *     no {n}th source row, a cap blocks it, or the 30-rule limit). The
 *     advice says to raise the number when an At least / Exactly rule of
 *     the token exists, and to switch to At least when only None / At most
 *     rules do (raising a cap still passes with none).
 *   - "missing": no rule names the token.
 * `text` is the full sentence, without the button.
 */
export interface NameCountWarning {
  kind: "raise" | "manual" | "missing";
  text: string;
  n: number;
  token: string;
  /** The token's {n}th source row; set only for "raise". */
  nthRow?: SourceTimelineRow;
}

/** The number an At least / Exactly rule requires; 0 for caps and None. */
function requiredCount(rule: BuildRule): number {
  const q = ruleQuantifier(rule);
  return q === "at_least" || q === "exactly" ? ruleCountValue(rule) ?? 0 : 0;
}

/** The {n}th row of the token when its click raises a rule to exactly n. */
function raisingRow(
  { n, token }: NameCount,
  rules: ReadonlyArray<BuildRule>,
  rows: ReadonlyArray<SourceTimelineRow>,
): SourceTimelineRow | undefined {
  const row = rows.filter((r) => r.what === token)[n - 1];
  const raise = row ? raiseRuleForRepeatRow(rules, rows, row) : null;
  if (!raise || raise.rule.count !== n) return undefined;
  if (raise.insert && rules.length >= RULES_MAX_PER_BUILD) return undefined;
  return row;
}

function warningFor(
  count: NameCount,
  rules: ReadonlyArray<BuildRule>,
  rows: ReadonlyArray<SourceTimelineRow>,
  countRepeats: boolean,
): NameCountWarning | null {
  const { n, token, text } = count;
  const own = rules.filter((r) => r.name === token);
  const entity = humanizeRuleEntity(token);
  const says = `The build name says “${text}”, but`;
  if (own.length === 0) {
    return { kind: "missing", text: `${says} no rule checks ${pluralizeEntity(entity)}.`, n, token };
  }
  const floor = Math.max(...own.map(requiredCount));
  if (floor >= n) return null;
  const has =
    floor === 0 ? `no ${entity}`
    : `${floor} ${floor === 1 ? entity : pluralizeEntity(entity)}`;
  const sentence = `${says} your rules pass with ${has}.`;
  const nthRow = countRepeats ? raisingRow(count, rules, rows) : undefined;
  if (nthRow) return { kind: "raise", text: sentence, n, token, nthRow };
  const raisable = own.some((r) => {
    const q = ruleQuantifier(r);
    return q === "at_least" || q === "exactly";
  });
  const advice = raisable
    ? "Raise the number on that rule and check its time."
    : `Change that rule to “At least ${n}”, or add an “At least ${n}” rule.`;
  return { kind: "manual", text: `${sentence} ${advice}`, n, token };
}

const NOTHING_DISMISSED: ReadonlySet<string> = new Set();

/**
 * The first name count the rules under-require, or null. L is the
 * largest At least / Exactly number among rules of the token (any time,
 * proxy or not); a count warns when L < n. `rows` are the source
 * timeline rows and `countRepeats` is true in create mode only (the
 * "raise" kind needs both). `dismissed` holds nameCountKey()s the user
 * dismissed this session; those are skipped.
 */
export function nameCountWarning(
  name: string,
  rules: ReadonlyArray<BuildRule>,
  rows: ReadonlyArray<SourceTimelineRow>,
  countRepeats: boolean,
  dismissed: ReadonlySet<string> = NOTHING_DISMISSED,
): NameCountWarning | null {
  for (const count of parseNameCounts(name)) {
    if (dismissed.has(nameCountKey(count))) continue;
    const warning = warningFor(count, rules, rows, countRepeats);
    if (warning) return warning;
  }
  return null;
}

/**
 * True when at least one rule has a name and every named rule only caps
 * or forbids (At most, None, Exactly 0), so a game with none of it
 * built still passes. Blank names are ignored.
 */
export function rulesRequireNothing(rules: ReadonlyArray<BuildRule>): boolean {
  const tones = rules.map(ruleTone).filter((tone) => tone !== "blank");
  return tones.length > 0 && tones.every((tone) => tone === "cap" || tone === "forbid");
}

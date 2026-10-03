/**
 * build-rules-copy — the plain words the rules editor, the timeline,
 * the preview and the toasts use for a custom-build rule.
 *
 * One vocabulary everywhere: At least · Exactly · At most · None, a
 * visible number and one connector, "before". The read-back sentence
 * states the edge cases ("one is enough", "games with none pass too",
 * "at or after the time is fine") so no glyph (≥ ≤ = ✓ ✗) is needed.
 *
 * Framework-agnostic (no React): renderers take the parts and apply
 * <strong> / font-mono themselves.
 */
import {
  PROXY_RULE_DISTANCE_HINT,
  formatTime,
  isProxyStructureToken,
  type BuildRule,
} from "@/lib/build-rules";
import {
  ruleCountValue,
  ruleQuantifier,
  type RuleQuantifier,
} from "@/lib/build-rules-quantity";

/** Same token shape sanitiseRule keeps; anything else is dropped on save. */
const RULE_TOKEN_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const VERB_PREFIX_RE = /^(Build|Train|Research|Morph)(?=[A-Z])/;
const RESEARCH_RE = /^Research[A-Z]/;

/* ------------------------------------------------------------------ */
/* Entity names                                                       */
/* ------------------------------------------------------------------ */

/** In-game names for tokens whose engine name reads badly. */
const ENTITY_OVERRIDES: Readonly<Record<string, string>> = {
  adeptpiercingattack: "Resonating Glaives",
  resonatingglaives: "Resonating Glaives",
  lurkermp: "Lurker",
  swarmhostmp: "Swarm Host",
  vikingfighter: "Viking",
};

/**
 * Display name for a rule token: strips the Build/Train/Research/Morph
 * verb, applies the in-game overrides (Glaives, LurkerMP, SwarmHostMP,
 * VikingFighter) and spaces camelCase and trailing digits.
 *   "BuildVoidRay" → "Void Ray"; "ResearchProtossGroundWeaponsLevel1"
 *   → "Protoss Ground Weapons Level 1"; "" → "".
 * Never changes the stored token.
 */
export function humanizeRuleEntity(name: string): string {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const stripped = raw.replace(VERB_PREFIX_RE, "");
  const normalized = stripped.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const override = ENTITY_OVERRIDES[normalized];
  if (override) return override;
  return stripped
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2");
}

/** Last words that read the same in the plural. */
const UNCHANGED_PLURALS: ReadonlySet<string> = new Set([
  "barracks",
  "templar",
  "archives",
]);

function pluralWord(word: string): string {
  const lower = word.toLowerCase();
  if (!word || UNCHANGED_PLURALS.has(lower)) return word;
  if (lower === "colossus") return `${word.slice(0, -2)}i`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/**
 * Plural of a humanised entity, changing only its last word:
 * Barracks / Templar / Archives stay, Colossus → Colossi, s/x/z/ch/sh
 * add "es" (Phoenixes, Nexuses), consonant + y → "ies" (Robotics
 * Facilities, Sentries), anything else adds "s".
 */
export function pluralizeEntity(entity: string): string {
  const s = String(entity || "");
  const cut = s.lastIndexOf(" ") + 1;
  return s.slice(0, cut) + pluralWord(s.slice(cut));
}

/**
 * The noun phrase for `rule` counted `n` times: singular only when
 * n === 1, "proxied " in front for proxy rules, and uncountable
 * "{Name} research" for Research tokens. A blank name reads as
 * "unit, building or upgrade" ("building" when proxied).
 *   ruleEntity(BuildVoidRay, 2) → "Void Rays"
 *   ruleEntity(BuildBarracks proxy, 1) → "proxied Barracks"
 *   ruleEntity(ResearchBlink, 3) → "Blink research"
 */
export function ruleEntity(
  rule: Pick<BuildRule, "name" | "proxy">,
  n: number,
): string {
  const name = String(rule.name || "").trim();
  const proxied = rule.proxy === true ? "proxied " : "";
  if (!name) {
    if (rule.proxy === true) return n === 1 ? "proxied building" : "proxied buildings";
    return n === 1 ? "unit, building or upgrade" : "units, buildings or upgrades";
  }
  const base = humanizeRuleEntity(name);
  if (RESEARCH_RE.test(name)) return `${proxied}${base} research`;
  return proxied + (n === 1 ? base : pluralizeEntity(base));
}

/* ------------------------------------------------------------------ */
/* Rule context                                                       */
/* ------------------------------------------------------------------ */

/** How a rule relates to the other rules of its token. */
export interface RuleContext {
  /** Another named rule uses the same token ("in total" on count phrases). */
  sameTokenElsewhere: boolean;
  /**
   * Another At least / Exactly rule of the same token asks for more
   * than this rule's number, so an "At least 1" rule here only sets the
   * first one's deadline.
   */
  higherFloorElsewhere: boolean;
}

const NO_CONTEXT: RuleContext = {
  sameTokenElsewhere: false,
  higherFloorElsewhere: false,
};

/** The number an At least / Exactly rule requires; 0 for caps and None. */
function requiredCount(rule: BuildRule): number {
  const q = ruleQuantifier(rule);
  return q === "at_least" || q === "exactly" ? ruleCountValue(rule) ?? 0 : 0;
}

/** One RuleContext per index of `rules` (same order, same length). */
export function ruleContexts(rules: ReadonlyArray<BuildRule>): RuleContext[] {
  return rules.map((rule, i) => {
    const named = String(rule.name || "").trim() !== "";
    const others = named
      ? rules.filter((r, j) => j !== i && r.name === rule.name)
      : [];
    const own = ruleCountValue(rule);
    return {
      sameTokenElsewhere: others.length > 0,
      higherFloorElsewhere:
        own !== null && others.some((r) => requiredCount(r) > own),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Short phrase, read-back and failure reason                         */
/* ------------------------------------------------------------------ */

const QUANTITY_WORDS: Record<Exclude<RuleQuantifier, "none">, string> = {
  at_least: "at least",
  exactly: "exactly",
  at_most: "at most",
};

/** True for None and for Exactly 0 / At most 0, which pass only with none. */
function passesOnlyWithNone(rule: BuildRule): boolean {
  const q = ruleQuantifier(rule);
  if (q === "none") return true;
  return q !== "at_least" && ruleCountValue(rule) === 0;
}

/**
 * The short lower-case phrase for a rule, used in aria labels, toasts,
 * live announcements and failure reasons:
 *   "at least 1 Void Ray before 6:40", "exactly 2 Stargates before 5:00",
 *   "at most 1 Stargate before 6:00", "no Robotics Facility before 4:00".
 * Exactly 0 / At most 0 read as "no …". No trailing period.
 */
export function describeRule(rule: BuildRule): string {
  const t = formatTime(rule.time_lt);
  if (passesOnlyWithNone(rule)) return `no ${ruleEntity(rule, 1)} before ${t}`;
  const q = ruleQuantifier(rule) as Exclude<RuleQuantifier, "none">;
  const n = ruleCountValue(rule) ?? 1;
  return `${QUANTITY_WORDS[q]} ${n} ${ruleEntity(rule, n)} before ${t}`;
}

/** Tone for a read-back note; absent means the paragraph's muted text. */
export type RuleReadoutTone = "dim" | "warning" | "danger";

/**
 * A read-back sentence split for rendering. `lead + strong + rest +
 * time + note` is the whole sentence (ruleReadoutText joins exactly
 * that). Render `strong` in <strong> and `time` in font-mono, each only
 * when non-empty, then `note` in `noteTone`. `note` always ends the
 * sentence, so it carries the closing period (" — one is enough." or
 * just "."). For a blank name, an invalid token or proxy on a
 * non-building, every part but `note` is "" and `note` is the message.
 */
export interface RuleReadout {
  lead: string;
  strong: string;
  rest: string;
  time: string;
  note: string;
  noteTone?: RuleReadoutTone;
}

function messageReadout(note: string, noteTone: RuleReadoutTone): RuleReadout {
  return { lead: "", strong: "", rest: "", time: "", note, noteTone };
}

/** The message that replaces the sentence for an unfinished rule, if any. */
function problemReadout(rule: BuildRule): RuleReadout | null {
  if (!String(rule.name || "").trim()) {
    return messageReadout("Enter a unit, building or upgrade to finish this rule.", "dim");
  }
  if (!RULE_TOKEN_RE.test(rule.name)) {
    return messageReadout(
      "This name won't be saved: use one word with no spaces, like BuildVoidRay or ResearchBlink.",
      "warning",
    );
  }
  if (rule.proxy === true && !isProxyStructureToken(rule.name)) {
    return messageReadout(
      "Only count proxied works for buildings. Enter one, like BuildPylon, or untick it.",
      "danger",
    );
  }
  return null;
}

/** "Passes when no X starts before t — …" for None, Exactly 0 and At most 0. */
function noneReadout(rule: BuildRule): RuleReadout {
  const time = formatTime(rule.time_lt);
  return {
    lead: "Passes when ",
    strong: "no",
    rest: ` ${ruleEntity(rule, 1)} starts before `,
    time,
    note:
      rule.type === "not_before"
        ? ` — at ${time} or later, or never, is fine.`
        : " — 0 works the same as None.",
  };
}

function countNote(
  q: RuleQuantifier,
  n: number,
  research: boolean,
  ctx: RuleContext,
): Pick<RuleReadout, "note" | "noteTone"> {
  if (q === "at_most") return { note: " — games with none pass too.", noteTone: "warning" };
  if (research && n >= 2) {
    return {
      note: " — research starts once per game, so this rarely passes.",
      noteTone: "warning",
    };
  }
  if (q === "exactly") {
    return { note: n === 1 ? " — none or 2 fails." : ` — ${n - 1} or ${n + 1} fails.` };
  }
  if (n !== 1) return { note: "." };
  return {
    note: ctx.higherFloorElsewhere
      ? " — sets the first one's deadline."
      : " — one is enough.",
  };
}

/** "Passes with N or more / exactly N / 0 to N … started before t". */
function countReadout(rule: BuildRule, ctx: RuleContext): RuleReadout {
  const q = ruleQuantifier(rule);
  const n = ruleCountValue(rule) ?? 1;
  const time = formatTime(rule.time_lt);
  const research = RESEARCH_RE.test(rule.name);
  if (research && q === "at_least" && n === 1) {
    const strong = ruleEntity(rule, 1);
    return { lead: "Passes when ", strong, rest: " starts before ", time, note: "." };
  }
  const strong =
    q === "at_least" ? `${n} or more`
    : q === "exactly" ? `exactly ${n}`
    : n === 1 ? "0 or 1"
    : `0 to ${n}`;
  // "1 or more Void Rays" is plural; "exactly 1" and "0 or 1" are not.
  const entity = ruleEntity(rule, q === "at_least" ? 2 : n);
  const total =
    ctx.sameTokenElsewhere && !(q === "at_least" && n === 1) ? " in total" : "";
  return {
    lead: "Passes with ",
    strong,
    rest: ` ${entity}${total} started before `,
    time,
    ...countNote(q, n, research, ctx),
  };
}

/**
 * The read-back sentence under a rule row, in parts (see RuleReadout).
 * `ctx` comes from ruleContexts(rules)[index]; omit it for a lone rule.
 *   before BuildVoidRay 6:40 → "Passes with **1 or more** Void Rays
 *   started before 6:40 — one is enough."
 */
export function ruleReadout(
  rule: BuildRule,
  ctx: RuleContext = NO_CONTEXT,
): RuleReadout {
  return (
    problemReadout(rule)
    ?? (passesOnlyWithNone(rule) ? noneReadout(rule) : countReadout(rule, ctx))
  );
}

/** ruleReadout as one plain string (aria text, tests). */
export function ruleReadoutText(
  rule: BuildRule,
  ctx: RuleContext = NO_CONTEXT,
): string {
  const r = ruleReadout(rule, ctx);
  return r.lead + r.strong + r.rest + r.time + r.note;
}

/**
 * Almost-match reason for a rule the game failed, given the count the
 * evaluator saw before the rule's time (`got`, 0 reads "none"):
 *   "Needs at least 4 Void Rays before 10:00 — this game had 1."
 */
export function describeRuleFailure(rule: BuildRule, got: number): string {
  return `Needs ${describeRule(rule)} — this game had ${got > 0 ? got : "none"}.`;
}

/* ------------------------------------------------------------------ */
/* Legend and toasts                                                  */
/* ------------------------------------------------------------------ */

/** One <dt>/<dd> pair of the "How rules count" legend. */
export interface RulesLegendEntry {
  term: string;
  detail: string;
}

/** The "How rules count" legend's <dt>/<dd> pairs, in order. */
export const RULES_LEGEND: ReadonlyArray<RulesLegendEntry> = [
  {
    term: "At least 2",
    detail:
      "2 or more pass. “At least 1” means a single one is enough (older versions called it “built by”).",
  },
  { term: "Exactly 2", detail: "Only 2 passes. 1 or 3 fails." },
  { term: "At most 2", detail: "0, 1 or 2 pass, so games with none pass too." },
  {
    term: "None",
    detail:
      "Not even one may start before the time. At the time or later, or never, is fine.",
  },
  {
    term: "before 4:20",
    detail:
      "Counts what starts before 4:20 on the game clock: when a building is placed, a unit starts, or research begins — not when it finishes.",
  },
  {
    term: "Only count proxied",
    detail: `Counts only buildings placed ${PROXY_RULE_DISTANCE_HINT}.`,
  },
];

/** The legend's closing line, under the <dl>. */
export const RULES_LEGEND_FOOTER =
  "A game matches only when every rule passes. The number counts every one started before the time, not extra ones.";

/**
 * Toast when a timeline "+" names a token that already has a rule:
 *   "Void Ray is already in your rules. Change its number there to require more."
 */
export function duplicateRuleToast(name: string): string {
  const entity = humanizeRuleEntity(name) || String(name || "");
  return `${entity} is already in your rules. Change its number there to require more.`;
}

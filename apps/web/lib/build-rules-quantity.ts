/**
 * build-rules-quantity — the editor's four-word quantity model over the
 * five stored v3 rule types. Nothing stored changes: every helper maps
 * to and from the existing `BuildRule` shapes.
 *
 *   At least n  ⇐ before (n = 1) | count_min n
 *   Exactly n   ⇐ count_exact n
 *   At most n   ⇐ count_max n
 *   None        ⇐ not_before
 *
 * `before` and `count_min 1` both read as "At least 1". They are
 * evaluator-equivalent: occurrences ≥ 1 in both the JS evaluator
 * (apps/api/src/services/buildRulesEvaluator.js) and the Python v3
 * branch (strategy_detector_base.py), and `tol` is never written by
 * the web or the API. A saved rule keeps its stored type until the
 * user changes the picker or the number.
 *
 * Framework-agnostic (no React) so the editor hook, the rule row and
 * the copy helpers share one definition.
 */
import { clampCount, isCountRule, type BuildRule, type RuleType } from "@/lib/build-rules";

/** The picker's vocabulary, ordered from requiring through capping to forbidding. */
export type RuleQuantifier = "at_least" | "exactly" | "at_most" | "none";

/** A quantifier's picker label, add-bar button copy and button tone. */
export interface RuleQuantifierOption {
  id: RuleQuantifier;
  /** Picker option label: "At least" / "Exactly" / "At most" / "None". */
  label: string;
  /** Add-bar button text (also its accessible name). */
  addLabel: string;
  /** Add-bar button title. */
  addTitle: string;
  /** Key into the editor's TONE_BTN_CLASSES. */
  tone: "win" | "loss" | "neutral";
  /** The stored type the add-bar button passes to addCustomRule. */
  addType: RuleType;
}

/** The four quantifiers in picker / add-bar order. */
export const RULE_QUANTIFIERS: ReadonlyArray<RuleQuantifierOption> = [
  {
    id: "at_least",
    label: "At least",
    addLabel: "At least",
    addTitle:
      "Require something: at least 1 to start. Raise the number in the rule to require more.",
    tone: "win",
    addType: "before",
  },
  {
    id: "exactly",
    label: "Exactly",
    addLabel: "Exactly",
    addTitle: "Require an exact number. One more or one fewer fails.",
    tone: "win",
    addType: "count_exact",
  },
  {
    id: "at_most",
    label: "At most",
    addLabel: "At most",
    addTitle: "Set a cap. Games with none pass too.",
    tone: "neutral",
    addType: "count_max",
  },
  {
    id: "none",
    label: "None",
    addLabel: "None before",
    addTitle:
      "Rule something out before a time. At that time or later, or never, is fine.",
    tone: "loss",
    addType: "not_before",
  },
];

/** The quantifier a stored rule reads as (`before` and `count_min` → "at_least"). */
export function ruleQuantifier(rule: BuildRule): RuleQuantifier {
  switch (rule.type) {
    case "before":
    case "count_min":
      return "at_least";
    case "count_exact":
      return "exactly";
    case "count_max":
      return "at_most";
    case "not_before":
      return "none";
  }
}

/** The number a rule shows: 1 for `before`, `count` for count types, null for `not_before`. */
export function ruleCountValue(rule: BuildRule): number | null {
  if (isCountRule(rule)) return rule.count;
  return rule.type === "before" ? 1 : null;
}

/** `{proxy: true}` when the rule carries it, else `{}`. */
function proxyOf(rule: BuildRule) {
  return rule.proxy === true ? { proxy: true as const } : {};
}

/**
 * `rule` re-expressed under quantifier `q`. Returns the SAME object when
 * `q` is already the rule's quantifier, so an unchanged picker never
 * dirties a saved build. Otherwise builds a fresh rule that keeps name,
 * time_lt and `proxy: true` (no other keys) and carries the number:
 * the rule's count, 1 for `before`, or `carry` (clamped 0–200) for
 * `not_before`, which has none. "At least" stores `before` for 1 and
 * `count_min` for 2+.
 *
 *   count_min 3  → at_most  = count_max 3
 *   count_max 0  → at_least = before
 *   not_before   → exactly  = count_exact carry
 */
export function withQuantifier(
  rule: BuildRule,
  q: RuleQuantifier,
  carry = 1,
): BuildRule {
  if (ruleQuantifier(rule) === q) return rule;
  const { name, time_lt } = rule;
  const proxy = proxyOf(rule);
  const n0 = ruleCountValue(rule) ?? clampCount(carry);
  if (q === "at_least") {
    const n = Math.max(1, n0);
    if (n === 1) return { type: "before", name, time_lt, ...proxy };
    return { type: "count_min", name, count: n, time_lt, ...proxy };
  }
  if (q === "exactly") return { type: "count_exact", name, count: n0, time_lt, ...proxy };
  if (q === "at_most") return { type: "count_max", name, count: n0, time_lt, ...proxy };
  return { type: "not_before", name, time_lt, ...proxy };
}

/**
 * `rule` with its number set to `raw` (clamped 0–200). Returns the SAME
 * object when nothing changes.
 *   - before: 2+ converts to count_min n (same time and proxy); 0–1 is
 *     a no-op, since `before` already means at least 1.
 *   - count_min: count = max(1, n); it stays count_min, so the stored
 *     type never flaps back to `before`.
 *   - count_exact / count_max: count = n (0 allowed).
 *   - not_before: no number, always a no-op.
 */
export function withCount(rule: BuildRule, raw: number | string): BuildRule {
  const n = clampCount(raw);
  const { name, time_lt } = rule;
  if (rule.type === "not_before") return rule;
  if (rule.type === "before") {
    if (n < 2) return rule;
    return { type: "count_min", name, count: n, time_lt, ...proxyOf(rule) };
  }
  const count = rule.type === "count_min" ? Math.max(1, n) : n;
  if (count === rule.count) return rule;
  return { type: rule.type, name, count, time_lt, ...proxyOf(rule) };
}

/** What a rule does to a game, for the row stripe and build-level callouts. */
export type RuleTone = "require" | "cap" | "forbid" | "blank";

/**
 * "require" for At least or Exactly 1+, "cap" for At most 1+, "forbid"
 * for None, Exactly 0 and At most 0 (all three pass only with none).
 * "blank" when the rule has no name yet.
 */
export function ruleTone(rule: BuildRule): RuleTone {
  if (!String(rule.name || "").trim()) return "blank";
  const q = ruleQuantifier(rule);
  if (q === "none") return "forbid";
  if (q === "at_least") return "require";
  const n = ruleCountValue(rule) ?? 0;
  if (n < 1) return "forbid";
  return q === "exactly" ? "require" : "cap";
}

/**
 * Left-border stripe class per tone (pair with `border-l-2`). The words
 * carry the meaning; colour is only a scanning aid.
 */
export const RULE_TONE_STRIPE: Record<RuleTone, string> = {
  require: "border-l-success/60",
  cap: "border-l-border-strong",
  forbid: "border-l-danger/60",
  blank: "border-l-border",
};

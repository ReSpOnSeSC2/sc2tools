/**
 * build-rules-repeat — turn a click on a LATER source-timeline row of a
 * token that already has a rule into the count that row stands for.
 *
 * A `before` rule passes on ONE event. The editor keeps one rule per
 * token, so clicking the 2nd Stargate used to be refused ("already in
 * your rules") and a build named "2 Stargate Void Ray" saved from the
 * timeline really meant "1+ Stargate, 1+ Void Ray" -- it matched any
 * Stargate game with a single Void Ray, Carrier rushes included, and the
 * cloud's ingest tagger then relabelled those games with its name.
 * Clicking the 2nd Stargate row now asks for "≥ 2 Stargate by then".
 *
 * Framework-agnostic (no React) so the editor hook and the timeline
 * panel share one definition of when a row can raise a rule.
 */
import {
  AUTO_PICK_TIME_BUFFER_SEC,
  TIME_LT_MAX,
  clampCount,
  clampRuleTime,
  isCountRule,
  type BuildRule,
  type SourceTimelineRow,
} from "@/lib/build-rules";

type RepeatRow = Pick<SourceTimelineRow, "what" | "t" | "isProxy">;

/** What a click on a repeated row does to the rules. */
export interface RepeatRowRaise {
  /** The rule to raise in place, or the `before` rule to insert after. */
  index: number;
  /** True when `rule` is inserted after `index` (the `before` rule stays). */
  insert: boolean;
  rule: Extract<BuildRule, { type: "count_min" }>;
}

/** Rows of the row's token up to and including its time. */
function rowsUpTo(
  rows: ReadonlyArray<RepeatRow>,
  row: RepeatRow,
  proxyOnly: boolean,
): number {
  return rows.filter(
    (r) =>
      r.what === row.what
      && r.t <= row.t
      && (!proxyOnly || r.isProxy === true),
  ).length;
}

/** True when `rule` counts the row (a proxy-only rule counts proxied rows). */
function covers(rule: BuildRule, row: RepeatRow): boolean {
  return rule.name === row.what && (rule.proxy !== true || row.isProxy === true);
}

/**
 * The count rule a click on `row` adds, or null when it adds nothing:
 *   - no `before` / `count_min` rule of the token counts the row
 *     (`not_before` / `count_max` / `count_exact` stay as the user set them);
 *   - a rule of the token already requires the row's count, or caps the
 *     count below it ("≤ 1 Stargate" never turns into "≥ 2");
 *   - the row is at the 30:00 rule ceiling, where rows share one clamped
 *     time and their count is not the row's own.
 *
 * An existing `count_min` is raised in place. A lone `before` keeps its
 * own deadline ("first Stargate by 3:20") and gets a count rule after it.
 * The new deadline is row + 30 s, never earlier than the rule's own.
 */
export function raiseRuleForRepeatRow(
  rules: ReadonlyArray<BuildRule>,
  rows: ReadonlyArray<RepeatRow>,
  row: RepeatRow,
): RepeatRowRaise | null {
  if (row.t >= TIME_LT_MAX) return null;
  let target: { index: number; rule: BuildRule; asked: number } | null = null;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!covers(rule, row)) continue;
    const asked = rowsUpTo(rows, row, rule.proxy === true);
    if (rule.type === "count_max" || rule.type === "count_exact") {
      if (rule.count < asked) return null;
      continue;
    }
    if (rule.type !== "before" && rule.type !== "count_min") continue;
    if ((isCountRule(rule) ? rule.count : 1) >= asked) return null;
    if (!target || (rule.type === "count_min" && target.rule.type !== "count_min")) {
      target = { index, rule, asked };
    }
  }
  if (!target) return null;
  return {
    index: target.index,
    insert: target.rule.type === "before",
    rule: {
      type: "count_min",
      name: target.rule.name,
      count: clampCount(target.asked),
      time_lt: Math.max(
        target.rule.time_lt,
        clampRuleTime(row.t + AUTO_PICK_TIME_BUFFER_SEC),
      ),
      ...(target.rule.proxy === true ? { proxy: true as const } : {}),
    },
  };
}

/** `rules` after applying `raise`. */
export function applyRepeatRowRaise(
  rules: ReadonlyArray<BuildRule>,
  raise: RepeatRowRaise,
): BuildRule[] {
  const next = rules.slice();
  if (raise.insert) next.splice(raise.index + 1, 0, raise.rule);
  else next[raise.index] = raise.rule;
  return next;
}

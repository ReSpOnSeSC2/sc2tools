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
  clampCount,
  clampRuleTime,
  type BuildRule,
  type SourceTimelineRow,
} from "@/lib/build-rules";

type RepeatRow = Pick<SourceTimelineRow, "what" | "t" | "isProxy">;

/** The count a click on `row` asks of `rule` and the count the rule
 * already requires, or null when `rule` cannot express "at least N": another
 * token, a type that is not "at least" (`not_before` / `count_max` /
 * `count_exact` stay as the user set them), or a non-proxy row against a
 * proxy-only rule. The asked count is the number of rows of the token up to
 * and including the clicked row's time (proxied rows only for a proxy rule).
 */
function askedCount(
  rule: BuildRule,
  rows: ReadonlyArray<RepeatRow>,
  row: RepeatRow,
): { asked: number; required: number } | null {
  if (rule.name !== row.what) return null;
  if (rule.type !== "before" && rule.type !== "count_min") return null;
  const proxyOnly = rule.proxy === true;
  if (proxyOnly && row.isProxy !== true) return null;
  const asked = rows.filter(
    (r) =>
      r.what === row.what
      && r.t <= row.t
      && (!proxyOnly || r.isProxy === true),
  ).length;
  return { asked, required: rule.type === "count_min" ? rule.count : 1 };
}

/**
 * The `count_min` rule a click on `row` asks of `rule`, or null when the
 * click adds nothing (see `askedCount`, or the rule already requires that
 * many). The deadline never moves earlier than the rule's own.
 */
export function repeatRowCountRule(
  rule: BuildRule,
  rows: ReadonlyArray<RepeatRow>,
  row: RepeatRow,
): BuildRule | null {
  const counts = askedCount(rule, rows, row);
  if (!counts || counts.asked <= counts.required) return null;
  return {
    type: "count_min",
    name: rule.name,
    count: clampCount(counts.asked),
    time_lt: Math.max(
      rule.time_lt,
      clampRuleTime(row.t + AUTO_PICK_TIME_BUFFER_SEC),
    ),
    ...(rule.proxy === true ? { proxy: true as const } : {}),
  };
}

/**
 * The first rule a click on `row` raises, with its index, or null -- also
 * null when another rule of the token already requires the row's count, so
 * a build with both "Stargate by 3:00" and "≥ 2 Stargate" is left alone.
 */
export function raiseRuleForRepeatRow(
  rules: ReadonlyArray<BuildRule>,
  rows: ReadonlyArray<RepeatRow>,
  row: RepeatRow,
): { index: number; rule: BuildRule } | null {
  let first: { index: number; rule: BuildRule } | null = null;
  for (let index = 0; index < rules.length; index += 1) {
    if (!askedCount(rules[index], rows, row)) continue;
    const raised = repeatRowCountRule(rules[index], rows, row);
    if (!raised) return null;
    first ??= { index, rule: raised };
  }
  return first;
}

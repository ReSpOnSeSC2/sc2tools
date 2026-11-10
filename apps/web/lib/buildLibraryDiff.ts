/**
 * Version comparisons for the build library's History sheet and the
 * "Review update" modal of saved community copies. Kept apart from
 * lib/buildLibrary.ts so only those (lazily loaded) dialogs ship it.
 */

import { coerceSavedRules } from "@/lib/build-rules";
import { describeRule } from "@/lib/build-rules-copy";

/* ------------------------------------------------------------------
 * Diffs (history and author updates)
 * ------------------------------------------------------------------ */

export interface RuleDiffRow {
  kind: "added" | "removed" | "changed" | "same";
  before?: string;
  after?: string;
}

/**
 * Rule-by-rule comparison keyed by rule type, event and proxy flag.
 * Example: a "before 4:00" rule that became "before 3:30" is "changed".
 */
export function diffRules(before: unknown, after: unknown): RuleDiffRow[] {
  const key = (rule: ReturnType<typeof coerceSavedRules>[number]) => `${rule.type}:${rule.name}:${rule.proxy ? 1 : 0}`;
  const was = new Map(coerceSavedRules(before).map((rule) => [key(rule), rule]));
  const rows: RuleDiffRow[] = [];
  for (const rule of coerceSavedRules(after)) {
    const old = was.get(key(rule));
    was.delete(key(rule));
    if (!old) rows.push({ kind: "added", after: describeRule(rule) });
    else if (describeRule(old) !== describeRule(rule)) rows.push({ kind: "changed", before: describeRule(old), after: describeRule(rule) });
    else rows.push({ kind: "same", after: describeRule(rule) });
  }
  for (const rule of was.values()) rows.push({ kind: "removed", before: describeRule(rule) });
  return rows;
}

const FIELD_LABELS: ReadonlyArray<[string, string]> = [
  ["name", "Name"], ["race", "Race"], ["vsRace", "Opponent race"], ["description", "Description"],
  ["skillLevel", "Skill level"], ["notes", "Notes"],
];

/** The plain fields that differ between two versions of a build. */
export function diffBuildFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: ReadonlyArray<string> = FIELD_LABELS.map(([field]) => field),
): Array<{ field: string; label: string; before: string; after: string }> {
  const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));
  return FIELD_LABELS.filter(([field]) => fields.includes(field) && text(before[field]) !== text(after[field]))
    .map(([field, label]) => ({ field, label, before: text(before[field]), after: text(after[field]) }));
}

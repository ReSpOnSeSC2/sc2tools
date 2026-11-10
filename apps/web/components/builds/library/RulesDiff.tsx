"use client";

import { diffBuildFields, diffRules } from "@/lib/buildLibraryDiff";

const KIND_STYLE = {
  added: { mark: "+", label: "Added", className: "border-success/40 bg-success/10" },
  removed: { mark: "−", label: "Removed", className: "border-danger/40 bg-danger/10" },
  changed: { mark: "~", label: "Changed", className: "border-warning/40 bg-warning/10" },
  same: { mark: "", label: "Unchanged", className: "border-border" },
} as const;

/**
 * Rules and plain fields that differ between two versions of a build
 * ("from" → "to"), each row named so it reads without colour.
 */
export function RulesDiff({
  from,
  to,
  fields,
  fromLabel = "Before",
  toLabel = "After",
}: {
  /** Two builds (or build snapshots) to compare. */
  from: object;
  to: object;
  /** Plain fields to compare (default: name, races, description, skill, notes). */
  fields?: ReadonlyArray<string>;
  fromLabel?: string;
  toLabel?: string;
}) {
  const before = from as Record<string, unknown>;
  const after = to as Record<string, unknown>;
  const rules = diffRules(before.rules, after.rules);
  const changed = diffBuildFields(before, after, fields);
  const differences = rules.filter((row) => row.kind !== "same").length + changed.length;
  return (
    <div className="space-y-3 text-caption">
      <p className="text-text-muted">
        {differences === 0 ? "No differences." : `${differences} difference${differences === 1 ? "" : "s"}.`}
      </p>
      {changed.length > 0 ? (
        <dl className="space-y-2">
          {changed.map((row) => (
            <div key={row.field} className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
              <dt className="font-semibold text-text">{row.label}</dt>
              <dd className="mt-1 break-words text-text-muted">
                <span className="sr-only">{fromLabel}: </span>
                <del className="text-text-dim">{row.before || "—"}</del>
                <span aria-hidden> → </span>
                <span className="sr-only">, {toLabel}: </span>
                <ins className="font-medium text-text no-underline">{row.after || "—"}</ins>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {rules.length > 0 ? (
        <ul aria-label="Rules" className="space-y-1.5">
          {rules.map((row, index) => {
            const style = KIND_STYLE[row.kind];
            return (
              <li key={`${row.kind}-${index}`} className={`flex gap-2 rounded-lg border px-3 py-2 ${style.className}`}>
                <span aria-hidden className="w-3 shrink-0 font-mono font-bold">{style.mark}</span>
                <span className="min-w-0 break-words">
                  <span className="sr-only">{style.label}: </span>
                  {row.kind === "changed" ? (
                    <>
                      <del className="text-text-dim">{row.before}</del>
                      <span aria-hidden> → </span>
                      <span className="sr-only"> now </span>
                      <span className="text-text">{row.after}</span>
                    </>
                  ) : (
                    <span className={row.kind === "same" ? "text-text-muted" : "text-text"}>{row.after ?? row.before}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-text-dim">Neither version has match rules.</p>
      )}
    </div>
  );
}

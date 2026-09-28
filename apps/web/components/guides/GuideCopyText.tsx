import { Fragment } from "react";
import type { GuideCopyLine } from "@/lib/guides/guideCopy";

/**
 * Renders deterministic guide prose (lib/guides/guideCopy) as one
 * paragraph. Each sentence keeps its `id` as a data attribute so tests
 * and reviewers can trace a rendered sentence back to its template.
 */
export function GuideCopyText({
  lines,
  className = "max-w-3xl text-body text-text-muted",
}: {
  lines: ReadonlyArray<GuideCopyLine>;
  className?: string;
}) {
  if (lines.length === 0) return null;
  return (
    <p className={className}>
      {lines.map((entry, index) => (
        <Fragment key={entry.id}>
          {index > 0 ? " " : null}
          <span data-copy-id={entry.id}>{entry.text}</span>
        </Fragment>
      ))}
    </p>
  );
}

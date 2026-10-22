"use client";

import { ChevronDown, ClipboardList } from "lucide-react";
import type { ReportContextItem, ReportContextItemId } from "@/lib/feedback/reportContext";

/**
 * "Included with your report": every diagnostic the report will carry,
 * each with its own checkbox. Collapsed by default so it doesn't crowd
 * the form; the summary says how many items are going.
 */
export function ReportContextPanel({
  items,
  excluded,
  onToggle,
}: {
  items: readonly ReportContextItem[];
  excluded: ReadonlySet<ReportContextItemId>;
  onToggle: (id: ReportContextItemId, included: boolean) => void;
}) {
  if (items.length === 0) return null;
  const included = items.filter((item) => !excluded.has(item.id)).length;

  return (
    <details className="group rounded-lg border border-border bg-bg-elevated/40">
      <summary
        className={[
          "flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-caption font-semibold text-text",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden",
        ].join(" ")}
      >
        <ClipboardList className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
        <span className="flex-1">Included with your report</span>
        <span className="font-normal text-text-dim">
          {included} of {items.length}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-dim transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-border px-3 pb-3 pt-2">
        <p className="text-caption text-text-dim">
          These help us find and fix the problem. Untick anything you'd rather not send.
        </p>
        <ul className="mt-2 space-y-0.5">
          {items.map((item) => (
            <li key={item.id}>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-1.5 py-2 hover:bg-bg-elevated">
                <input
                  type="checkbox"
                  checked={!excluded.has(item.id)}
                  onChange={(event) => onToggle(item.id, event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-caption font-medium text-text">{item.label}</span>
                  <span className="block break-words font-mono text-micro text-text-muted">{item.value}</span>
                  {item.details?.length ? (
                    <span className="mt-1 block space-y-0.5">
                      {item.details.map((line, index) => (
                        // The same request can fail twice in a row.
                        <span key={`${index}:${line}`} className="block break-all font-mono text-micro text-text-dim">
                          {line}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

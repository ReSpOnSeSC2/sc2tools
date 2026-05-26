"use client";

import { formatRule, type BuildRule } from "@/lib/build-rules";
import type { AutoCandidateRule } from "./types";

export interface AutoCandidateRulesPreviewProps {
  rules: ReadonlyArray<AutoCandidateRule>;
  /** Optional id to associate the list with a labelling heading. */
  "aria-labelledby"?: string;
}

/**
 * Plain-English list of the v3 rules powering an auto-discovery
 * candidate. Renders one row per rule:
 *
 *   "Stargate"  before  3:30
 *   "no Robotics Facility"  before  4:00
 *   "≤ 2 Phoenix"  by  5:00
 *
 * Timings are rendered in JetBrains Mono (`font-mono tabular-nums`) so
 * they line up vertically when the list contains multiple rules.
 * Reflows on small screens — each row wraps independently and never
 * forces horizontal scroll.
 */
export function AutoCandidateRulesPreview({
  rules,
  "aria-labelledby": labelledBy,
}: AutoCandidateRulesPreviewProps) {
  if (rules.length === 0) {
    return (
      <p className="text-caption text-text-dim">No rules captured for this candidate.</p>
    );
  }
  return (
    <ul
      role="list"
      aria-labelledby={labelledBy}
      className="space-y-1.5 text-caption"
    >
      {rules.map((r, i) => {
        const f = formatRule(r as BuildRule);
        return (
          <li
            key={`${r.type}-${r.name}-${r.time_lt}-${i}`}
            className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-text"
          >
            <span className="break-words">
              <span
                className={
                  r.type === "not_before" ? "text-danger" : "text-text-muted"
                }
              >
                {f.prefix}
              </span>
              <span className="font-medium text-text">{f.entity}</span>
            </span>
            <span className="text-text-dim">{f.connector}</span>
            <span className="font-mono tabular-nums text-accent-cyan">
              {f.time}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

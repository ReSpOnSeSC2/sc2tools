"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { CompositionMatchupMatrix } from "./CompositionMatchupMatrix";
import {
  classifyWinRate,
  lowConfidenceHashStyle,
  WR_LABELS,
} from "./shared/winRateColors";
import type { CompositionMatchupBlock } from "./shared/snapshotTypes";

// Mobile-only condensed view: shows just the user's row from the
// matchup matrix (1×K) with cells styled like the full matrix.
// "Expand to full matrix" reveals the K×K version inline (still
// horizontally scrollable for very narrow viewports).

export interface CompositionMatchupRowProps {
  block: CompositionMatchupBlock | null;
}

export function CompositionMatchupRow({ block }: CompositionMatchupRowProps) {
  const [expanded, setExpanded] = useState(false);

  if (!block) {
    return (
      <Card title="Composition matchup">
        <p className="py-3 text-center text-caption text-text-dim">
          No composition matrix at this tick yet.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Composition matchup">
      <Card.Body>
        <p className="mb-2 text-caption text-text-muted">
          You are playing as{" "}
          <span className="font-semibold text-text">{block.myCluster.label}</span>.
          Win rates vs each opposing comp:
        </p>
        <div className="-mx-2 overflow-x-auto px-2">
          <ul className="flex gap-1.5 snap-x snap-mandatory pb-2" role="list">
            {block.fullRow.map((row) => {
              const cls = classifyWinRate(row.winRate, row.sampleSize);
              return (
                <li key={row.oppClusterId} className="snap-start">
                  <div
                    className="flex h-20 w-24 flex-col items-center justify-center rounded-md p-2 text-center text-[11px] font-semibold text-white"
                    style={{
                      background: cls.color,
                      opacity: cls.lowConfidence ? 0.6 : 1,
                      ...(cls.lowConfidence ? lowConfidenceHashStyle() : {}),
                    }}
                    aria-label={`vs ${row.oppLabel} — ${cls.label} — ${Math.round(row.winRate * 100)}% win rate over ${row.sampleSize} games`}
                  >
                    <span aria-hidden className="text-lg leading-none">{cls.glyph}</span>
                    <span className="mt-1 tabular-nums">{Math.round(row.winRate * 100)}%</span>
                    <span className="mt-1 text-[9px] font-normal opacity-80">{row.oppLabel}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-2 text-caption font-medium text-accent hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {expanded ? "Hide full matrix" : "Expand to full matrix"}
        </button>
        {expanded ? (
          <div className="mt-3 overflow-x-auto">
            <CompositionMatchupMatrix block={block} />
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}

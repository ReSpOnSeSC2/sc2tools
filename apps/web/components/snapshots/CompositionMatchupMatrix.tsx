"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import {
  classifyWinRate,
  lowConfidenceHashStyle,
  WR_LABELS,
} from "./shared/winRateColors";
import type {
  CompositionMatchupBlock,
  MatchupCell,
  MatrixResponse,
} from "./shared/snapshotTypes";

// K×K composition matchup matrix at the focal tick. Cells colored
// by win rate via the colorblind-safe palette. The user's focal
// cell is highlighted with a thick border. Cells below the
// confidence threshold render with a hashed pattern and a "Low
// confidence" tooltip.
//
// Desktop-first: full K×K grid. Mobile callers should use
// CompositionMatchupRow instead — this component does not collapse
// to a single row; it just becomes scrollable in narrow viewports.

export interface CompositionMatchupMatrixProps {
  block: CompositionMatchupBlock | null;
  /** When given, overrides the matrix block (used by the cohort browser tab). */
  matrixOverride?: MatrixResponse | null;
  onCellSelect?: (myId: string, oppId: string) => void;
  highlightFocal?: boolean;
}

export function CompositionMatchupMatrix({
  block,
  matrixOverride,
  onCellSelect,
  highlightFocal = true,
}: CompositionMatchupMatrixProps) {
  const [activeCell, setActiveCell] = useState<{ my: string; opp: string } | null>(null);

  const matrix = useMemo(() => {
    if (matrixOverride) {
      return {
        my: matrixOverride.matrix.myClusters.map((c) => ({ id: c.id, label: c.label })),
        opp: matrixOverride.matrix.oppClusters.map((c) => ({ id: c.id, label: c.label })),
        rows: matrixOverride.matrix.rows,
        focalMy: undefined,
        focalOpp: undefined,
      };
    }
    if (block) {
      return {
        my: block.fullMatrix.myClusters.map((id) => ({
          id,
          label: id === block.myCluster.id ? block.myCluster.label : id,
        })),
        opp: block.fullMatrix.oppClusters.map((id) => ({
          id,
          label: id === block.oppCluster.id ? block.oppCluster.label : id,
        })),
        rows: block.fullMatrix.rows,
        focalMy: block.myCluster.id,
        focalOpp: block.oppCluster.id,
      };
    }
    return null;
  }, [block, matrixOverride]);

  if (!matrix) {
    return (
      <Card title="Composition matchup">
        <p className="py-4 text-center text-caption text-text-dim">
          No composition matrix at this tick yet.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Composition matchup">
      <Card.Body>
        <div className="overflow-x-auto" role="region" aria-label="Composition matchup matrix">
          <table className="min-w-full border-collapse text-caption">
            <thead>
              <tr>
                <th aria-hidden className="px-2 py-1" />
                {matrix.opp.map((c) => (
                  <th
                    key={c.id}
                    scope="col"
                    className="px-2 py-1 text-left text-[10px] font-medium text-text-muted whitespace-nowrap"
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.my.map((myCluster, rowIdx) => (
                <tr key={myCluster.id}>
                  <th
                    scope="row"
                    className="px-2 py-1 text-right text-[10px] font-medium text-text-muted whitespace-nowrap"
                  >
                    {myCluster.label}
                  </th>
                  {matrix.opp.map((oppCluster, colIdx) => {
                    const cell: MatchupCell = matrix.rows[rowIdx]?.[colIdx] || {
                      winRate: 0,
                      sampleSize: 0,
                      ci: [0, 1],
                    };
                    const isFocal =
                      highlightFocal &&
                      matrix.focalMy === myCluster.id &&
                      matrix.focalOpp === oppCluster.id;
                    const isActive =
                      activeCell?.my === myCluster.id && activeCell?.opp === oppCluster.id;
                    const cls = classifyWinRate(cell.winRate, cell.sampleSize, cell.ci);
                    return (
                      <td key={oppCluster.id} className="p-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveCell({ my: myCluster.id, opp: oppCluster.id });
                            onCellSelect?.(myCluster.id, oppCluster.id);
                          }}
                          aria-label={`${myCluster.label} vs ${oppCluster.label} — ${cls.label}, ${Math.round(cell.winRate * 100)}% win rate, ${cell.sampleSize} games`}
                          title={cls.lowConfidence ? `${cls.label} — n=${cell.sampleSize}` : undefined}
                          className={[
                            "flex h-12 w-16 items-center justify-center rounded text-[11px] font-semibold tabular-nums text-white",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                            isFocal ? "ring-2 ring-amber-400 ring-offset-1 ring-offset-bg" : "",
                            isActive ? "outline outline-2 outline-accent" : "",
                          ].join(" ")}
                          style={{
                            background: cls.color,
                            opacity: cls.lowConfidence ? 0.55 : 1,
                            ...(cls.lowConfidence ? lowConfidenceHashStyle() : {}),
                          }}
                        >
                          <span aria-hidden className="flex flex-col items-center leading-tight">
                            <span>{cls.glyph}</span>
                            <span>{Math.round(cell.winRate * 100)}%</span>
                          </span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Legend />
      </Card.Body>
    </Card>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-text-muted">
      {(Object.keys(WR_LABELS) as Array<keyof typeof WR_LABELS>).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-flex h-3 w-4 items-center justify-center rounded-sm text-[9px] font-bold text-white"
            style={{
              background:
                k === "favorable"
                  ? "#22c55e"
                  : k === "neutral"
                    ? "#9aa3b2"
                    : k === "unfavorable"
                      ? "#ef4444"
                      : "#3a4252",
            }}
          >
            {k === "favorable" ? "▲" : k === "unfavorable" ? "▼" : k === "neutral" ? "●" : "·"}
          </span>
          {WR_LABELS[k]}
        </span>
      ))}
    </div>
  );
}

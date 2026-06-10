"use client";

/**
 * Run / cancel controls with generation progress for the optimizer
 * worker. The search is anytime — cancelling still returns the best
 * build found so far.
 */
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { OptimizeProgress } from "@/lib/optimizer/types";
import type { OptimizerStatus } from "@/lib/optimizer/worker/useOptimizerWorker";

export function RunControls({
  status,
  progress,
  error,
  maxGenerations,
  threatCount,
  likelyCount,
  onRun,
  onCancel,
}: {
  status: OptimizerStatus;
  progress: OptimizeProgress | null;
  error: string | null;
  maxGenerations: number;
  /** All enabled threats in the matchup (baseline constraints). */
  threatCount: number;
  /** Threats scouted-likely or pinned (high-weight constraints). */
  likelyCount: number;
  onRun: () => void;
  onCancel: () => void;
}) {
  const running = status === "running";
  const fraction = progress
    ? Math.min(1, progress.generation / maxGenerations)
    : 0;
  return (
    <Card title="Optimize">
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Button
            onClick={onRun}
            loading={running}
            iconLeft={<Play className="h-4 w-4" />}
          >
            {running ? "Optimizing…" : "Find safest build"}
          </Button>
          {running ? (
            <Button
              variant="secondary"
              onClick={onCancel}
              iconLeft={<Square className="h-4 w-4" />}
            >
              Stop (keep best)
            </Button>
          ) : null}
        </div>
        <p className="text-caption text-text-dim">
          {threatCount === 0
            ? "No threats enabled for this matchup — the optimizer will purely chase the objective."
            : likelyCount > 0
              ? `Defending ${threatCount} matchup threat${threatCount === 1 ? "" : "s"} — ${likelyCount} scouted-likely or pinned (weighted heavily).`
              : `Defending the ${threatCount}-threat matchup baseline at meta odds. Scout something to sharpen the weighting.`}
        </p>
        {running || progress ? (
          <div className="space-y-1.5">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={maxGenerations}
              aria-valuenow={progress?.generation ?? 0}
              className="h-2 overflow-hidden rounded-full bg-bg-elevated"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${Math.round(fraction * 100)}%` }}
              />
            </div>
            {progress ? (
              <p className="text-caption text-text-muted">
                Generation {progress.generation}/{maxGenerations} ·{" "}
                {progress.evaluations.toLocaleString()} builds simulated · best:{" "}
                {progress.bestSummary}
              </p>
            ) : null}
          </div>
        ) : null}
        {status === "error" && error ? (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        ) : null}
        {status === "cancelled" ? (
          <p className="text-caption text-warning">
            Stopped early — showing the best build found before the cancel.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

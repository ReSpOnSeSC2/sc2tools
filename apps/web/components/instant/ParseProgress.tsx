"use client";

/**
 * ParseProgress — status of a running Instant Analysis: the current stage
 * (the first boot downloads the ~8 MB analyzer once, then it is cached),
 * a determinate progress bar, a Cancel button and a summary of skipped or
 * failed replays grouped by kind (counts only, never file names).
 *
 * Only the stage label is a live region; the per-file count lives on the
 * progressbar (`aria-valuenow` / `aria-valuetext`) so screen readers are
 * not flooded with an announcement per replay.
 *
 * Example:
 *   <ParseProgress progress={session.progress} phase={session.phase}
 *     total={session.files.length} failed={session.failed} onCancel={session.cancel} />
 */
import { AlertTriangle, MinusCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { summarizeFailures, type FailureGroup } from "@/lib/instant/errorCopy";
import { isRunningPhase, type InstantSessionPhase, type SessionProgress } from "@/lib/instant/sessionState";
import type { FailedParse } from "@/lib/instant/types";

export interface ParseProgressProps {
  progress: SessionProgress | null;
  phase: InstantSessionPhase;
  /** Replays in the run (used until the engine reports its own total). */
  total: number;
  failed: FailedParse[];
  onCancel: () => void;
  className?: string;
}

export const BOOT_LABEL = "Starting the analyzer… (first run downloads about 8 MB, then it's cached)";
const PERCENT = 100;

const PHASE_LABELS: Record<InstantSessionPhase, string> = {
  idle: "Ready when you are",
  ready: "Ready when you are",
  booting: BOOT_LABEL,
  scanning: "Reading who played in each replay…",
  choosing: "Waiting for you to pick your player",
  parsing: "Analysing replays…",
  done: "Analysis complete",
  error: "The analyzer stopped",
};

/**
 * Human label for the current stage (engine boot and .zip unpacking win,
 * since they can happen while the session is idle or ready).
 *
 * Example:
 *   stageLabel("parsing", null); // -> "Analysing replays…"
 */
export function stageLabel(phase: InstantSessionPhase, progress: SessionProgress | null): string {
  if (progress?.phase === "boot") return BOOT_LABEL;
  if (progress?.phase === "unzip") return "Unpacking your .zip…";
  return PHASE_LABELS[phase];
}

function barValues(phase: InstantSessionPhase, progress: SessionProgress | null, total: number): { done: number; max: number } {
  if (progress && progress.phase !== "boot") return { done: progress.done, max: Math.max(1, progress.total) };
  const max = Math.max(1, total);
  return { done: phase === "done" ? max : 0, max };
}

function FailureSummary({ groups }: { groups: FailureGroup[] }) {
  return (
    <div className="space-y-2">
      <h3 className="text-caption font-semibold text-text">Skipped or not analysed</h3>
      <ul className="space-y-2">
        {groups.map((group) => {
          const Icon = group.skipped ? MinusCircle : AlertTriangle;
          return (
            <li key={group.kind} className="flex gap-2 text-caption">
              <Icon className={["mt-0.5 h-4 w-4 flex-shrink-0", group.skipped ? "text-text-dim" : "text-warning"].join(" ")} aria-hidden />
              <span className="min-w-0">
                <span className="font-semibold tabular-nums text-text">{group.count}</span>
                <span className="font-semibold text-text"> · {group.copy.title}</span>
                <span className="block text-text-muted">{group.copy.hint}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Progress + failures for one run.
 *
 * Example:
 *   <ParseProgress progress={null} phase="booting" total={12} failed={[]} onCancel={cancel} />
 */
export function ParseProgress({ progress, phase, total, failed, onCancel, className = "" }: ParseProgressProps) {
  const label = stageLabel(phase, progress);
  const { done, max } = barValues(phase, progress, total);
  const percent = Math.round((Math.min(done, max) / max) * PERCENT);
  const cancellable = (isRunningPhase(phase) && phase !== "choosing") || progress?.phase === "unzip";
  const groups = summarizeFailures(failed);
  return (
    <section
      aria-label="Analysis progress"
      className={["space-y-4 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard", className].filter(Boolean).join(" ")}
    >
      <p role="status" aria-live="polite" className="text-body font-semibold text-text">
        {label}
      </p>
      <div className="space-y-1">
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={done}
          aria-valuetext={`${done} of ${max}`}
          className="h-3 overflow-hidden rounded-full border-2 border-line bg-bg-elevated"
        >
          <div className="h-full bg-accent transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
        </div>
        <p className="text-caption tabular-nums text-text-muted">
          {done} of {max}
        </p>
      </div>
      {cancellable ? (
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      {groups.length > 0 ? <FailureSummary groups={groups} /> : null}
    </section>
  );
}

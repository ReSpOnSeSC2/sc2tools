"use client";

import { useId, useState } from "react";
import { AlertTriangle, ArrowRight, TimerReset } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import {
  GHOST_MATCHUPS,
  type GhostMatchupKey,
  type GhostTarget,
} from "@/lib/ghostBuild";

const RACE_GROUPS = [
  {
    label: "When you play Terran",
    options: [
      ["TvT", "Terran vs Terran"],
      ["TvP", "Terran vs Protoss"],
      ["TvZ", "Terran vs Zerg"],
    ],
  },
  {
    label: "When you play Protoss",
    options: [
      ["PvT", "Protoss vs Terran"],
      ["PvP", "Protoss vs Protoss"],
      ["PvZ", "Protoss vs Zerg"],
    ],
  },
  {
    label: "When you play Zerg",
    options: [
      ["ZvT", "Zerg vs Terran"],
      ["ZvP", "Zerg vs Protoss"],
      ["ZvZ", "Zerg vs Zerg"],
    ],
  },
] as const satisfies ReadonlyArray<{
  label: string;
  options: ReadonlyArray<readonly [GhostMatchupKey, string]>;
}>;

export function GhostLegacyMigration({
  target,
  onMigrate,
  disabled = false,
}: {
  target: GhostTarget;
  onMigrate: (matchup: GhostMatchupKey) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [matchup, setMatchup] = useState<GhostMatchupKey | "">("");
  const duration = target.steps.reduce(
    (latest, step) => Math.max(latest, step.t),
    0,
  );

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="min-w-0 max-w-full rounded-xl border border-warning/40 bg-warning/10 p-3 sm:p-4"
      data-testid="ghost-legacy-migration"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-warning/20 text-warning">
          <AlertTriangle className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3
            id={`${id}-title`}
            className="font-display text-body-lg font-bold text-text"
          >
            Upgrade your previous Ghost build
          </h3>
          <p className="mt-1 max-w-3xl text-caption text-text-muted">
            This build was saved before per-matchup coaching. Choose the one
            exact matchup it belongs to; Ghost will not guess or copy it into
            the other eight slots.
          </p>
        </div>
      </div>

      <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.75fr)]">
        <div className="min-w-0 rounded-lg border border-border bg-bg-surface/70 px-3 py-2.5">
          <p
            className="break-words text-body font-semibold text-text [overflow-wrap:anywhere]"
            title={target.name}
          >
            {target.name}
          </p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-micro text-text-muted">
            <span>
              {target.steps.length} timed step
              {target.steps.length === 1 ? "" : "s"}
            </span>
            <span aria-hidden>{"\u00b7"}</span>
            <span className="inline-flex items-center gap-1 tabular-nums">
              <TimerReset className="h-3.5 w-3.5" aria-hidden />
              through {formatDuration(duration)}
            </span>
          </div>
        </div>

        <div className="min-w-0">
          <label
            htmlFor={`${id}-matchup`}
            className="block text-micro font-semibold uppercase tracking-wider text-text-dim"
          >
            Assign to one matchup
          </label>
          <Select
            id={`${id}-matchup`}
            className="mt-1 min-w-0 max-w-full"
            value={matchup}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              setMatchup(
                GHOST_MATCHUPS.includes(next as GhostMatchupKey)
                  ? (next as GhostMatchupKey)
                  : "",
              );
            }}
          >
            <option value="">Choose the exact matchup</option>
            {RACE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map(([key, label]) => (
                  <option key={key} value={key}>
                    {key} — {label}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
      </div>

      <div className="mt-3 flex min-w-0 flex-col gap-2 border-t border-warning/30 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-micro text-text-muted">
          Your original build stays untouched unless the upgrade and saved
          library write both succeed.
        </p>
        <Button
          variant="primary"
          size="sm"
          className="w-full flex-shrink-0 sm:w-auto"
          disabled={disabled || !matchup}
          iconRight={<ArrowRight className="h-4 w-4" aria-hidden />}
          onClick={() => {
            if (matchup) onMigrate(matchup);
          }}
        >
          {matchup ? `Upgrade to ${matchup}` : "Choose a matchup"}
        </Button>
      </div>
    </section>
  );
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

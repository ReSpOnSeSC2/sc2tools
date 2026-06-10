"use client";

/**
 * Threat list for the selected matchup: live probability badges from
 * scouting inference, pin/unpin (force the optimizer to defend a
 * threat regardless of probability), enable/disable, and the editor
 * launcher for tuning the catalog when the meta shifts.
 */
import { useMemo, useState } from "react";
import { Pencil, Pin, PinOff, Plus, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/Card";
import { formatBuildTime } from "@/lib/build-events";
import { ACTIVE_THRESHOLD } from "@/lib/optimizer/scouting/infer";
import {
  emptyOverlay,
  shippedThreatIds,
  type ThreatOverlay,
} from "@/lib/optimizer/threats/store";
import type {
  ScoutingObservation,
  SimRace,
  Threat,
  ThreatAssessment,
} from "@/lib/optimizer/types";
import { ScoutingInput } from "./ScoutingInput";
import { ThreatEditorModal } from "./ThreatEditorModal";

function probabilityVariant(p: number): "danger" | "warning" | "neutral" {
  if (p >= 0.6) return "danger";
  if (p >= ACTIVE_THRESHOLD) return "warning";
  return "neutral";
}

export function ThreatPanel({
  threats,
  assessments,
  observations,
  pinnedThreatIds,
  overlay,
  defenderRace,
  onObservationsChange,
  onPinnedChange,
  onOverlayChange,
}: {
  threats: Threat[];
  assessments: ThreatAssessment[];
  observations: ScoutingObservation[];
  pinnedThreatIds: string[];
  overlay: ThreatOverlay;
  defenderRace: SimRace;
  onObservationsChange: (next: ScoutingObservation[]) => void;
  onPinnedChange: (next: string[]) => void;
  onOverlayChange: (next: ThreatOverlay) => void;
}) {
  const [editing, setEditing] = useState<Threat | "new" | null>(null);
  const assessmentById = useMemo(
    () => new Map(assessments.map((a) => [a.threatId, a])),
    [assessments],
  );
  const shipped = useMemo(() => shippedThreatIds(), []);
  const pinned = new Set(pinnedThreatIds);
  const hasOverlayEdits =
    Object.keys(overlay.overrides).length > 0 ||
    overlay.disabled.length > 0 ||
    overlay.added.length > 0;

  const togglePin = (id: string) => {
    onPinnedChange(
      pinned.has(id)
        ? pinnedThreatIds.filter((p) => p !== id)
        : [...pinnedThreatIds, id],
    );
  };

  return (
    <Card
      title="Threats"
      right={
        <div className="flex items-center gap-1.5">
          {hasOverlayEdits ? (
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={() => onOverlayChange(emptyOverlay())}
            >
              Reset
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setEditing("new")}
          >
            Add
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-4">
        {threats.length === 0 ? (
          <EmptyState
            title="No threats for this matchup"
            sub="Add one with the button above — it persists on this device."
          />
        ) : (
          <ul className="space-y-2">
            {threats.map((threat) => {
              const assessment = assessmentById.get(threat.id);
              const probability =
                assessment?.probability ?? threat.priorProbability;
              const isActive =
                Boolean(assessment?.active) || pinned.has(threat.id);
              return (
                <li
                  key={threat.id}
                  className={[
                    "rounded-lg border-2 p-3 transition-colors",
                    isActive
                      ? "border-accent/50 bg-accent/5"
                      : "border-line bg-bg-surface",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-semibold text-text">
                        {threat.name}
                      </span>
                      <Badge variant={probabilityVariant(probability)} size="sm">
                        {Math.round(probability * 100)}%
                      </Badge>
                      {isActive ? (
                        <Badge variant="accent" size="sm">
                          defending
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={
                          pinned.has(threat.id)
                            ? `Unpin ${threat.name}`
                            : `Pin ${threat.name} (always defend)`
                        }
                        className="rounded p-1 text-text-muted hover:bg-bg-elevated hover:text-text"
                        onClick={() => togglePin(threat.id)}
                      >
                        {pinned.has(threat.id) ? (
                          <PinOff className="h-4 w-4" />
                        ) : (
                          <Pin className="h-4 w-4" />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={`Edit ${threat.name}`}
                        className="rounded p-1 text-text-muted hover:bg-bg-elevated hover:text-text"
                        onClick={() => setEditing(threat)}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 text-caption text-text-muted">
                    {threat.description}
                  </p>
                  <p className="mt-1 text-caption text-text-dim">
                    First hit ~{formatBuildTime(threat.earliestArrivalSec)} ·{" "}
                    {threat.waves.length} wave
                    {threat.waves.length === 1 ? "" : "s"}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
        <ScoutingInput
          threats={threats}
          observations={observations}
          onChange={onObservationsChange}
        />
        <p className="text-caption text-text-dim">
          Threats at {Math.round(ACTIVE_THRESHOLD * 100)}%+ probability (or
          pinned) become safety constraints for the optimizer.
        </p>
      </div>
      <ThreatEditorModal
        open={editing !== null}
        threat={editing === "new" ? null : editing}
        isShipped={
          editing !== null && editing !== "new" && shipped.has(editing.id)
        }
        defenderRace={defenderRace}
        overlay={overlay}
        onClose={() => setEditing(null)}
        onSave={(next) => {
          onOverlayChange(next);
          setEditing(null);
        }}
      />
    </Card>
  );
}

"use client";

/**
 * Safety-check list: which enemy openers should the adapted build be
 * tested against? Threats are derived from the same reference catalog
 * the standard openers come from — each one is the opponent's build
 * simulated on the current patch, with arrival waves read off its
 * army production — plus a couple of curated cheeses (8-pool,
 * marine/SCV) that aren't catalog openers. All are checked by
 * default; unchecking removes a threat from the safety report.
 */
import { useState } from "react";
import { Pencil, Plus, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, EmptyState } from "@/components/ui/Card";
import { formatBuildTime } from "@/lib/build-events";
import {
  emptyOverlay,
  shippedThreatIds,
  type ThreatOverlay,
} from "@/lib/optimizer/threats/store";
import type { SimRace, Threat } from "@/lib/optimizer/types";
import { ThreatEditorModal } from "./ThreatEditorModal";

export function ThreatPanel({
  threats,
  disabledThreatIds,
  overlay,
  defenderRace,
  onDisabledChange,
  onOverlayChange,
}: {
  /** Derived + curated threats for the matchup, arrival-sorted. */
  threats: Threat[];
  disabledThreatIds: string[];
  overlay: ThreatOverlay;
  defenderRace: SimRace;
  onDisabledChange: (next: string[]) => void;
  onOverlayChange: (next: ThreatOverlay) => void;
}) {
  const [editing, setEditing] = useState<Threat | "new" | null>(null);
  const shipped = shippedThreatIds();
  const disabled = new Set(disabledThreatIds);
  const hasOverlayEdits =
    Object.keys(overlay.overrides).length > 0 ||
    overlay.disabled.length > 0 ||
    overlay.added.length > 0;

  const toggle = (id: string) => {
    onDisabledChange(
      disabled.has(id)
        ? disabledThreatIds.filter((d) => d !== id)
        : [...disabledThreatIds, id],
    );
  };

  return (
    <Card
      title="Check safety against"
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
      <div className="space-y-3 p-4">
        {threats.length === 0 ? (
          <EmptyState
            title="No threats for this matchup"
            sub="Add one with the button above — it persists on this device."
          />
        ) : (
          <ul className="max-h-[360px] space-y-1.5 overflow-y-auto pr-1">
            {threats.map((threat) => {
              const isDerived = threat.id.startsWith("ref:");
              const enabled = !disabled.has(threat.id);
              return (
                <li
                  key={threat.id}
                  className="flex items-start gap-2 rounded-lg border-2 border-line/25 bg-bg-surface p-2.5"
                >
                  <input
                    id={`threat-${threat.id}`}
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-[rgb(var(--accent))]"
                    checked={enabled}
                    onChange={() => toggle(threat.id)}
                  />
                  <label
                    htmlFor={`threat-${threat.id}`}
                    className="flex-1 cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-body font-semibold text-text">
                        {threat.name}
                      </span>
                      <Badge variant={isDerived ? "cyan" : "warning"} size="sm">
                        {isDerived ? "from catalog" : "cheese"}
                      </Badge>
                    </span>
                    <span className="block text-caption text-text-dim">
                      first hit ~{formatBuildTime(threat.earliestArrivalSec)} ·{" "}
                      {threat.waves.length} wave
                      {threat.waves.length === 1 ? "" : "s"}
                    </span>
                  </label>
                  {!isDerived ? (
                    <button
                      type="button"
                      aria-label={`Edit ${threat.name}`}
                      className="rounded p-1 text-text-muted hover:bg-bg-elevated hover:text-text"
                      onClick={() => setEditing(threat)}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-caption text-text-dim">
          Catalog threats are the opponent&apos;s openers from the definitions
          catalog, simulated on the selected patch — their arrival times move
          with the patch automatically. Uncheck anything you&apos;ve scouted
          out; the safety report covers whatever stays checked.
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

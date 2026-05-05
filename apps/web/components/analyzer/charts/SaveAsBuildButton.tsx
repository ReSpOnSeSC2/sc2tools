"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SaveAsBuildModal } from "./SaveAsBuildModal";
import type {
  BuildEventRow,
  BuildPerspective,
  Race,
  SaveAsBuildPayload,
  VsRace,
} from "./BuildOrderTimeline.types";

/**
 * SaveAsBuildButton — opens SaveAsBuildModal with the current
 * perspective's events as the build snapshot. The button is the
 * integration point for surfaces that pass an onSaveAsBuild handler
 * to the timeline.
 */
export interface SaveAsBuildButtonProps {
  rows: BuildEventRow[];
  perspective: BuildPerspective;
  race: Race;
  vsRace: VsRace;
  defaultName?: string;
  gameId?: string;
  /** Notified after a successful save. */
  onSaved?: (payload: SaveAsBuildPayload & { slug: string }) => void;
  /** Custom save handler — overrides the built-in API call. */
  onCustomSave?: (
    payload: SaveAsBuildPayload & { slug: string },
  ) => Promise<void> | void;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export function SaveAsBuildButton({
  rows,
  perspective,
  race,
  vsRace,
  defaultName,
  gameId,
  onSaved,
  onCustomSave,
  disabled,
  size = "sm",
  className = "",
}: SaveAsBuildButtonProps) {
  const [open, setOpen] = useState(false);
  const noEvents = rows.length === 0;
  return (
    <>
      <Button
        variant="primary"
        size={size}
        onClick={() => setOpen(true)}
        disabled={disabled || noEvents}
        iconLeft={<Save className="h-4 w-4" aria-hidden />}
        title={
          noEvents
            ? "No mappable build events on this game"
            : "Save the current view as a custom build"
        }
        className={className}
      >
        Save as new build
      </Button>
      <SaveAsBuildModal
        open={open}
        onClose={() => setOpen(false)}
        rows={rows}
        defaultName={defaultName}
        perspective={perspective}
        race={race}
        vsRace={vsRace}
        gameId={gameId}
        onSaved={(payload) => {
          onSaved?.(payload);
        }}
        onCustomSave={onCustomSave}
      />
    </>
  );
}

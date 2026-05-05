"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { BuildEditorModal } from "@/components/builds/editor";
import type { BuildOrderEvent } from "@/lib/build-events";
import type {
  BuildEventRow,
  BuildPerspective,
  Race,
  SaveAsBuildPayload,
  VsRace,
} from "./BuildOrderTimeline.types";

/**
 * SaveAsBuildButton — opens the rich BuildEditorModal pre-seeded with
 * the active perspective's raw events. Replaces the legacy lite
 * SaveAsBuildModal so the cloud editor reaches feature parity with
 * the local SPA.
 *
 * The button is the integration point for surfaces that pass an
 * `onSaveAsBuild` handler to the BuildOrderTimeline. Parents are
 * notified via `onSaved` after a successful save.
 */
export interface SaveAsBuildButtonProps {
  /** Display rows — used only to gate the button when there are 0 events. */
  rows: ReadonlyArray<BuildEventRow>;
  /** Raw events for the active perspective, fed into the editor. */
  events: ReadonlyArray<BuildOrderEvent>;
  perspective: BuildPerspective;
  race: Race;
  vsRace: VsRace;
  defaultName?: string;
  gameId?: string;
  /** Notified after a successful save (no return value expected). */
  onSaved?: (payload: SaveAsBuildPayload & { slug: string }) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export function SaveAsBuildButton({
  rows,
  events,
  perspective,
  race,
  vsRace,
  defaultName,
  gameId,
  onSaved,
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
      <BuildEditorModal
        open={open}
        onClose={() => setOpen(false)}
        events={events}
        gameId={gameId}
        race={race}
        vsRace={vsRace}
        perspective={perspective}
        defaultName={defaultName}
        onSaved={(slug, draft) => {
          onSaved?.({
            slug,
            name: draft.name,
            race: draft.race,
            vsRace: draft.vsRace,
            rows: rows.slice(),
            gameId,
            perspective,
          });
        }}
      />
    </>
  );
}

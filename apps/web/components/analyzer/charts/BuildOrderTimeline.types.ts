/**
 * Shared types for the BuildOrderTimeline widget cluster
 * (timeline orchestrator, row, perspective toggle, save-as modal).
 *
 * Defined once here so each sub-component can import without a
 * circular dependency back through the main timeline file.
 */
import type {
  BuildEventRow,
  BuildOrderEvent,
} from "@/lib/build-events";

export type BuildPerspective = "you" | "opponent";

export type Race = "Protoss" | "Terran" | "Zerg" | "Random";

export type VsRace = Race | "Any";

/** Payload passed to a save-as-build callback. */
export interface SaveAsBuildPayload {
  /** Display name the user typed. */
  name: string;
  /** Auto-detected from `perspective`. */
  race: Race;
  /** Auto-detected from the opposite perspective's race. */
  vsRace: VsRace;
  /** Snapshot of normalized rows for the active perspective. */
  rows: BuildEventRow[];
  /** Stable per-game id so the API can backref the source replay. */
  gameId?: string;
  /** Active perspective at save time. */
  perspective: BuildPerspective;
}

/** Public props for BuildOrderTimeline. */
export interface BuildOrderTimelineProps {
  /** Player's events (always required — at minimum, render the user's build). */
  events: BuildOrderEvent[];
  /** Opponent's events. When omitted, the perspective toggle is disabled. */
  oppEvents?: BuildOrderEvent[];
  /** Controlled perspective. When omitted, the component manages it internally. */
  perspective?: BuildPerspective;
  /** Initial perspective when uncontrolled. */
  defaultPerspective?: BuildPerspective;
  /** Notified when the user changes perspective via the toggle. */
  onPerspectiveChange?: (next: BuildPerspective) => void;
  /**
   * When provided, the "Save as new build" button is rendered. Called
   * with the snapshot payload after the user submits the modal.
   * Falsy return / no return → modal closes; throw → modal stays
   * open and the error is surfaced inline.
   */
  onSaveAsBuild?: (payload: SaveAsBuildPayload) => Promise<void> | void;
  /** Optional game id used in the save payload. */
  gameId?: string;
  /** Player race — drives row tints + save-flow defaults. */
  race: Race | string | null | undefined;
  /** Opponent race — drives save-flow vsRace default. */
  oppRace: Race | string | null | undefined;
  /** Optional human label shown above the timeline ("Your build", "Opp's build"). */
  title?: string;
  /** Override the empty-state copy. */
  emptyStateTitle?: string;
  emptyStateBody?: string;
  className?: string;
}

export type { BuildEventRow, BuildOrderEvent };

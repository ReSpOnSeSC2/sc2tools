/**
 * Local types for the BuildEditor (modal, sections, hook).
 *
 * The rule schema + draft live in `@/lib/build-rules`. These types
 * pin down the props each section receives so the orchestrator can
 * pass a single state object around without leaking concerns.
 */
import type { Dispatch, SetStateAction } from "react";
import type {
  BuildEditorDraft,
  BuildEditorErrors,
  BuildRule,
  RaceLite,
  SkillLevelId,
  SourceTimelineRow,
  VsRaceLite,
} from "@/lib/build-rules";
import type { BuildOrderEvent } from "@/lib/build-events";

export interface BuildEditorPreviewMatch {
  game_id: string;
  build_name: string;
  map?: string | null;
  result?: string | null;
  date?: string | null;
}

export interface BuildEditorPreviewAlmost extends BuildEditorPreviewMatch {
  failed_rule_name?: string;
  failed_reason: string;
}

export interface BuildEditorPreviewResult {
  matches: BuildEditorPreviewMatch[];
  almost_matches: BuildEditorPreviewAlmost[];
  scanned_games: number;
  truncated: boolean;
}

export interface BuildEditorContext {
  /** Game id of the source replay (provenance). */
  gameId?: string;
  /** Source replay events for the rule-builder source-timeline column. */
  sourceEvents: ReadonlyArray<BuildOrderEvent>;
  /** Pre-computed source rows. Memoised by parent. */
  sourceRows: ReadonlyArray<SourceTimelineRow>;
  /** Default name to seed the form with. */
  defaultName: string;
  /** Initial perspective (informational — surfaces in the header). */
  perspective: "you" | "opponent";
  /** Surface where the build was created (for the "Save & Reclassify" hint). */
  surface?: "buildEditor" | "saveAsBuild";
}

export interface BuildEditorState {
  draft: BuildEditorDraft;
  setDraft: Dispatch<SetStateAction<BuildEditorDraft>>;

  /** Inline error map driven by sanitiseDraft. */
  errors: BuildEditorErrors;

  preview: BuildEditorPreviewResult | null;
  previewLoading: boolean;
  previewError: string | null;
  previewPage: number;
  almostPage: number;
  setPreviewPage: Dispatch<SetStateAction<number>>;
  setAlmostPage: Dispatch<SetStateAction<number>>;

  /** Inspect / hide rows in the preview lists. */
  expandedMatchId: string | null;
  toggleInspect: (gameId: string) => void;
  hiddenMatchIds: ReadonlySet<string>;
  hideMatch: (gameId: string) => void;
  unhideAll: () => void;
  inspectCache: Readonly<Record<string, ReadonlyArray<BuildOrderEvent>>>;
  inspectLoading: Readonly<Record<string, boolean>>;

  saving: boolean;
  saveError: string | null;
  savedOk: boolean;

  /** Update one rule by index. */
  updateRule: (idx: number, patch: Partial<BuildRule>) => void;
  /** Remove one rule. */
  removeRule: (idx: number) => void;
  /** Cycle one rule's type. */
  cycleRule: (idx: number) => void;
  /** Add a rule from an SPA event. */
  addRuleFromEvent: (ev: {
    time: number;
    name: string;
    is_building?: boolean;
    race?: string;
    category?: string;
  }) => void;
  /** Add a custom rule of the given type. */
  addCustomRule: (
    type: BuildRule["type"],
  ) => void;

  /** True when the draft differs from the pristine snapshot. */
  isDirty: boolean;

  /** Persist the draft. `andReclassify` wires through to backend. */
  save: (andReclassify: boolean) => Promise<void>;

  /** Toasts queued by the editor. */
  toasts: BuildEditorToast[];
  pushToast: (
    kind: BuildEditorToastKind,
    text: string,
    action?: BuildEditorToast["action"],
  ) => void;
  dismissToast: (id: string) => void;
}

export type BuildEditorToastKind = "success" | "error" | "warn";

export interface BuildEditorToast {
  id: string;
  kind: BuildEditorToastKind;
  text: string;
  action?: { label: string; href: string };
}

export interface BuildEditorBasicsProps {
  draft: BuildEditorDraft;
  setDraft: Dispatch<SetStateAction<BuildEditorDraft>>;
  errors: BuildEditorErrors;
}

export interface BuildEditorRulesProps {
  draft: BuildEditorDraft;
  errors: BuildEditorErrors;
  sourceRows: ReadonlyArray<SourceTimelineRow>;
  updateRule: BuildEditorState["updateRule"];
  removeRule: BuildEditorState["removeRule"];
  cycleRule: BuildEditorState["cycleRule"];
  addRuleFromEvent: BuildEditorState["addRuleFromEvent"];
  addCustomRule: BuildEditorState["addCustomRule"];
}

export interface BuildEditorPreviewProps {
  preview: BuildEditorPreviewResult | null;
  loading: boolean;
  error: string | null;
  rules: ReadonlyArray<BuildRule>;
  expandedMatchId: string | null;
  toggleInspect: (gameId: string) => void;
  hiddenMatchIds: ReadonlySet<string>;
  hideMatch: (gameId: string) => void;
  unhideAll: () => void;
  inspectCache: Readonly<Record<string, ReadonlyArray<BuildOrderEvent>>>;
  inspectLoading: Readonly<Record<string, boolean>>;
  previewPage: number;
  almostPage: number;
  setPreviewPage: Dispatch<SetStateAction<number>>;
  setAlmostPage: Dispatch<SetStateAction<number>>;
}

export type {
  BuildEditorDraft,
  BuildEditorErrors,
  BuildRule,
  RaceLite,
  SkillLevelId,
  SourceTimelineRow,
  VsRaceLite,
};

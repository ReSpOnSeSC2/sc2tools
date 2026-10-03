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
import type { RuleQuantifier } from "@/lib/build-rules-quantity";
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
  /**
   * Index of the failed rule in the rules array the preview was
   * requested with (BuildEditorState.previewRules). Absent on older APIs.
   */
  failed_rule_index?: number;
  /** How many the game had before the failed rule's time. */
  failed_count?: number;
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
  /**
   * Whether a later row of a token already in the rules can raise it to
   * "at least N" (default true). False when the rows are not a replay's events
   * but are rebuilt from a saved build's rule deadlines (edit mode).
   */
  countRepeats?: boolean;
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
  /**
   * The exact `draft.rules` array sent with the request whose result
   * is in `preview` (so almost-match indexes resolve against it); []
   * in demo mode and when there are no rules.
   */
  previewRules: ReadonlyArray<BuildRule>;
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

  /** Update one rule's name, time or proxy flag by index. */
  updateRule: (idx: number, patch: Partial<BuildRule>) => void;
  /** Remove one rule. */
  removeRule: (idx: number) => void;
  /**
   * Re-express one rule under a quantifier (withQuantifier). `carry` is
   * the number a None rule takes when it gains one (default 1).
   */
  setRuleQuantity: (idx: number, q: RuleQuantifier, carry?: number) => void;
  /** Set one rule's number (withCount); `before` becomes count_min at 2+. */
  setRuleCount: (idx: number, n: number) => void;
  /** Add a rule from an SPA event. */
  addRuleFromEvent: (ev: {
    time: number;
    name: string;
    is_building?: boolean;
    is_proxy?: boolean;
    race?: string;
    category?: string;
  }) => void;
  /** Add a custom rule of the given type. */
  addCustomRule: (
    type: BuildRule["type"],
    options?: { proxyOnly?: boolean },
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

export interface BuildEditorSaveResult {
  reclassifyRequested: boolean;
  reclassifyStatus?: "queued" | "running" | "retry" | "complete";
  reclassifyGeneration?: string;
  reclassifyError?: string;
  communityAction?: "published" | "updated" | "unpublished";
  communitySlug?: string;
  communityError?: string;
  communityMirrorPending?: boolean;
  /** Authoritative visibility re-read after a partial Community failure. */
  communityPublished?: boolean;
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
  /** See BuildEditorContext.countRepeats. */
  countRepeats?: boolean;
  updateRule: BuildEditorState["updateRule"];
  removeRule: BuildEditorState["removeRule"];
  setRuleQuantity: BuildEditorState["setRuleQuantity"];
  setRuleCount: BuildEditorState["setRuleCount"];
  addRuleFromEvent: BuildEditorState["addRuleFromEvent"];
  addCustomRule: BuildEditorState["addCustomRule"];
}

export interface BuildEditorPreviewProps {
  preview: BuildEditorPreviewResult | null;
  loading: boolean;
  error: string | null;
  rules: ReadonlyArray<BuildRule>;
  /** See BuildEditorState.previewRules. */
  previewRules: ReadonlyArray<BuildRule>;
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

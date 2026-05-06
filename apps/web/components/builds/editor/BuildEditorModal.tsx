"use client";

import { useMemo } from "react";
import {
  deriveDefaultName,
  eventsToSourceRows,
  type BuildEditorDraft,
  type RaceLite,
  type VsRaceLite,
} from "@/lib/build-rules";
import type { BuildOrderEvent } from "@/lib/build-events";
import { Modal } from "@/components/ui/Modal";
import { useBuildEditorState } from "./useBuildEditorState";
import { BuildEditorBasics } from "./BuildEditorBasics";
import { BuildEditorRules } from "./BuildEditorRules";
import { BuildEditorPreview } from "./BuildEditorPreview";
import { BuildEditorSaveBar } from "./BuildEditorSaveBar";
import { BuildEditorToasts } from "./BuildEditorToasts";

export interface BuildEditorModalProps {
  open: boolean;
  onClose: () => void;
  /** Source replay events the editor uses for the timeline column. */
  events: ReadonlyArray<BuildOrderEvent>;
  /** Stable game id used for provenance + inspect cache. */
  gameId?: string;
  /** Default values for race / vsRace / name when creating from a game. */
  race: RaceLite;
  vsRace: VsRaceLite;
  /** Perspective the user was on at the time of save. */
  perspective?: "you" | "opponent";
  /** Pre-fill the name field. */
  defaultName?: string;
  /** Called when a save succeeds with the persisted slug + draft. */
  onSaved?: (slug: string, draft: BuildEditorDraft) => void;
  /**
   * Optional initial draft override. The edit-existing-build entry
   * point seeds this from a fetched custom-build doc so name, rules,
   * skill level and strategy notes appear pre-populated.
   */
  initialDraft?: Partial<BuildEditorDraft>;
  /**
   * When set, save() targets this slug instead of slugifying the name.
   * Use this for the edit-existing-build flow so renames update the
   * same document rather than creating a new one.
   */
  lockedSlug?: string;
  /** Switches the title eyebrow from "Save as new build" to "Edit build". */
  mode?: "create" | "edit";
}

/**
 * BuildEditorModal — the rich, parity-with-SPA build editor.
 *
 * Wraps:
 *   1. Basics (name, race, vs, skill level, description, share, strategy notes)
 *   2. Match rules (source timeline + rules list + custom rule pickers)
 *   3. Match preview (live debounced /preview-matches against user's games)
 *   4. Sticky save bar (Save build / Save & Reclassify)
 *
 * State is owned by `useBuildEditorState` so individual section
 * components stay below the 800-line cap. Persists to
 * PUT /v1/custom-builds/:slug with schemaVersion=3 + the v3 rules array.
 */
export function BuildEditorModal({
  open,
  onClose,
  events,
  gameId,
  race,
  vsRace,
  perspective = "you",
  defaultName,
  onSaved,
  initialDraft,
  lockedSlug,
  mode = "create",
}: BuildEditorModalProps) {
  const sourceRows = useMemo(() => eventsToSourceRows(events), [events]);

  const computedDefaultName = useMemo(
    () =>
      defaultName?.trim() ||
      deriveDefaultName({
        myBuild: undefined,
        myRace: race,
        oppRace: typeof vsRace === "string" && vsRace !== "Any" ? vsRace : "",
        perspective,
      }),
    [defaultName, race, vsRace, perspective],
  );

  const seedDraft: BuildEditorDraft = useMemo(
    () => ({
      name: initialDraft?.name ?? computedDefaultName,
      description: initialDraft?.description ?? "",
      race: initialDraft?.race ?? race,
      vsRace: initialDraft?.vsRace ?? vsRace,
      skillLevel: initialDraft?.skillLevel ?? null,
      shareWithCommunity: initialDraft?.shareWithCommunity ?? true,
      winConditions: initialDraft?.winConditions ?? [],
      losesTo: initialDraft?.losesTo ?? [],
      transitionsInto: initialDraft?.transitionsInto ?? [],
      rules: initialDraft?.rules ?? [],
      sourceReplayId: initialDraft?.sourceReplayId ?? gameId,
    }),
    [
      initialDraft,
      computedDefaultName,
      race,
      vsRace,
      gameId,
    ],
  );

  const editor = useBuildEditorState({
    open,
    initialDraft: seedDraft,
    lockedSlug,
    context: {
      gameId,
      sourceEvents: events,
      sourceRows,
      defaultName: computedDefaultName,
      perspective,
      surface: "buildEditor",
    },
    onSaved: (slug, draft) => {
      onSaved?.(slug, draft);
      // Auto-close shortly after a successful save so the user sees
      // the toast confirm before the modal disappears.
      window.setTimeout(() => onClose(), 700);
    },
  });

  return (
    <>
      <Modal
        open={open}
        onClose={editor.saving ? () => undefined : onClose}
        title={
          <span className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              {mode === "edit" ? "Edit build" : "Save as new build"}
            </span>
            <span className="truncate text-h4 font-semibold text-text">
              {editor.draft.name || "Untitled"}
            </span>
          </span>
        }
        description={
          editor.draft.rules.length === 0 ? (
            <>
              Add rules below to capture the signature of this build.
              Click <span className="font-semibold">+</span> on a starred
              event to start, or pick a custom rule type.
            </>
          ) : (
            <>
              {editor.draft.rules.length} rule
              {editor.draft.rules.length === 1 ? "" : "s"} ·{" "}
              {editor.preview?.scanned_games ?? 0} games scanned ·{" "}
              {editor.preview?.matches.length ?? 0} matches.
            </>
          )
        }
        size="3xl"
        disableScrimClose={editor.saving}
        hideClose={editor.saving}
        footer={
          <BuildEditorSaveBar
            ruleCount={editor.draft.rules.length}
            saving={editor.saving}
            previewLoading={editor.previewLoading}
            saveError={editor.saveError}
            onCancel={onClose}
            onSave={editor.save}
            mode={mode}
          />
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            editor.save(false);
          }}
          className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-5"
        >
          <div className="flex min-w-0 flex-col gap-4">
            <BuildEditorBasics
              draft={editor.draft}
              setDraft={editor.setDraft}
              errors={editor.errors}
            />
            <BuildEditorPreview
              preview={editor.preview}
              loading={editor.previewLoading}
              error={editor.previewError}
              rules={editor.draft.rules}
              expandedMatchId={editor.expandedMatchId}
              toggleInspect={editor.toggleInspect}
              hiddenMatchIds={editor.hiddenMatchIds}
              hideMatch={editor.hideMatch}
              unhideAll={editor.unhideAll}
              inspectCache={editor.inspectCache}
              inspectLoading={editor.inspectLoading}
              previewPage={editor.previewPage}
              almostPage={editor.almostPage}
              setPreviewPage={editor.setPreviewPage}
              setAlmostPage={editor.setAlmostPage}
            />
          </div>
          <div className="min-w-0">
            <BuildEditorRules
              draft={editor.draft}
              errors={editor.errors}
              sourceRows={sourceRows}
              updateRule={editor.updateRule}
              removeRule={editor.removeRule}
              cycleRule={editor.cycleRule}
              addRuleFromEvent={editor.addRuleFromEvent}
              addCustomRule={editor.addCustomRule}
            />
          </div>
        </form>
      </Modal>
      <BuildEditorToasts toasts={editor.toasts} dismiss={editor.dismissToast} />
    </>
  );
}

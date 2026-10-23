"use client";

import { useMemo, useRef } from "react";
import {
  deriveDefaultName,
  eventsToSourceRows,
  type BuildEditorDraft,
  type RaceLite,
  type VsRaceLite,
} from "@/lib/build-rules";
import type { BuildEditorSaveResult } from "./BuildEditor.types";
import type { BuildOrderEvent, BuildSignatureItem } from "@/lib/build-events";
import { Modal } from "@/components/ui/Modal";
import { useToastOptional } from "@/components/ui/Toast";
import { useBuildEditorCloseGuard } from "./useBuildEditorCloseGuard";
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
  onSaved?: (
    slug: string,
    draft: BuildEditorDraft,
    result: BuildEditorSaveResult,
  ) => void;
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
  /**
   * Demo mode (landing-page replay preview). The editor stays fully
   * interactive — name, race/vsRace, source-timeline rule promotion,
   * "Add a rule" bar, strategy notes — but the preview-matches
   * fetch is suppressed and Save is replaced with a sign-up CTA.
   */
  demoMode?: boolean;
  /**
   * Keep the build on the source game's matchup: `race` is read-only and
   * the vs race is limited to `vsRace` or Any. Used when the new build
   * must fit the game it is created from (build check-in).
   */
  lockMatchup?: boolean;
  /**
   * Create a new build only, never overwrite one: the save asks the API
   * to refuse a name whose slug already exists (live or deleted), and
   * the editor shows that as a name error. Ignored with `lockedSlug`.
   */
  createOnly?: boolean;
  initialFocus?: "notes" | "preview";
  legacySignature?: boolean;
  sourceSignature?: BuildSignatureItem[];
  saveIntent?: "duplicate";
  timelineFromSavedBuild?: boolean;
}

/**
 * BuildEditorModal — the rich, parity-with-SPA build editor.
 *
 * Wraps:
 *   1. Basics (name, race, vs, skill level, description, share, strategy notes)
 *   2. Match rules (source timeline + rules list + "Add a rule" bar)
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
  demoMode = false,
  lockMatchup = false,
  createOnly = false,
  initialFocus,
  legacySignature = false,
  sourceSignature,
  saveIntent,
  timelineFromSavedBuild = false,
}: BuildEditorModalProps) {
  const toast = useToastOptional()?.toast;
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const sourceRows = useMemo(() => eventsToSourceRows(events), [events]);
  // Edit mode rebuilds the timeline from the saved rules' deadlines
  // (EditCustomBuildLauncher.docToEvents), so two rows of a token are two
  // rules, not two Stargates, and must not be counted.
  const countRepeats = mode !== "edit" && !timelineFromSavedBuild;

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
      notes: initialDraft?.notes ?? "",
      race: initialDraft?.race ?? race,
      vsRace: initialDraft?.vsRace ?? vsRace,
      skillLevel: initialDraft?.skillLevel ?? null,
      // Default OFF for brand-new builds: publishing is an explicit
      // opt-in, never a side effect of saving. The edit-existing flow
      // seeds this from the saved doc so an already-public build keeps
      // its toggle on.
      shareWithCommunity: initialDraft?.shareWithCommunity ?? false,
      communityAuthorName: initialDraft?.communityAuthorName ?? "",
      publishAnonymously: initialDraft?.publishAnonymously ?? false,
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

  const lockedMatchup = useMemo(
    () => (lockMatchup ? { race, vsRace } : undefined),
    [lockMatchup, race, vsRace],
  );

  const editor = useBuildEditorState({
    open,
    initialDraft: seedDraft,
    lockedSlug,
    demoMode,
    createOnly,
    sourceSignature,
    saveIntent,
    context: {
      gameId,
      sourceEvents: events,
      sourceRows,
      countRepeats,
      defaultName: computedDefaultName,
      perspective,
      surface: "buildEditor",
    },
    onSaved: (slug, draft, result) => {
      if (result.reclassifyError) {
        toast?.error("Build saved, but replay matching couldn't start", {
          description: friendlyReclassifyError(result.reclassifyError),
        });
      }
      if (result.communityError) {
        if (result.communityPublished === false && !draft.shareWithCommunity) {
          toast?.warning("Build saved; Community listing was removed", {
            description:
              "Current Community visibility was verified even though the original confirmation was interrupted.",
          });
        } else if (result.communityPublished === true && draft.shareWithCommunity) {
          toast?.warning("Build saved; Community listing remains public", {
            description:
              "Its visibility was verified, but the listing update was not fully confirmed. Review it before retrying.",
          });
        } else if (!draft.shareWithCommunity) {
          toast?.error("Build saved; Community listing is still public", {
            description:
              "Removal failed, so the existing listing remains visible. Try again.",
          });
        } else {
          toast?.error("Build saved; Community listing wasn't updated", {
            description:
              result.communityError === "public_author_name_required"
                ? "Add a profile or community name, or explicitly choose Post anonymously, then save again."
                : "Your prior Community listing is unchanged. Try the update again.",
          });
        }
      }
      if (result.communityMirrorPending) {
        toast?.warning("Community change is live; library badge is syncing", {
          description:
            "The public listing already has the requested state. Reopen the editor to retry the library badge sync.",
        });
      }
      onSaved?.(slug, draft, result);
      // Global notifications survive the editor. Close this instance now;
      // a stale delayed callback could discard a newly opened editor.
      onClose();
    },
  });

  const guard = useBuildEditorCloseGuard({ open, dirty: !demoMode && editor.isDirty, saving: editor.saving, name: editor.draft.name, onClose });

  return (
    <>
      <Modal
        open={open}
        onClose={guard.requestClose}
        initialFocusRef={initialFocus === "notes" ? notesRef : initialFocus === "preview" ? previewRef : undefined}
        title={
          <span className="flex items-center gap-2">
            <span className="text-micro font-semibold uppercase tracking-wider text-text-muted">
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
              event to start, or use the “Add a rule” buttons.
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
            saveError={editor.saveError}
            onCancel={guard.requestClose}
            onSave={editor.save}
            mode={mode}
            hasSignature={!!sourceSignature?.length}
            demoMode={demoMode}
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
          <fieldset disabled={editor.saving || editor.savedOk} className="contents">
          <div className="flex min-w-0 flex-col gap-4">
            <BuildEditorBasics
              draft={editor.draft}
              setDraft={editor.setDraft}
              errors={editor.errors}
              lockedMatchup={lockedMatchup}
              notesRef={notesRef}
              onAuthorDefault={editor.seedAuthorName}
            />
            <BuildEditorPreview
              focusRef={previewRef}
              preview={editor.preview}
              loading={editor.previewLoading}
              error={editor.previewError}
              rules={editor.draft.rules}
              previewRules={editor.previewRules}
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
            {legacySignature && editor.draft.rules.length === 0 ? <p role="note" className="mb-4 rounded-lg border border-accent-cyan/30 bg-accent-cyan/10 p-3 text-caption text-text-muted">This build uses the older signature format. Click a timeline row to turn it into a rule. Until you add one, it keeps matching by its signature.</p> : null}
            <BuildEditorRules
              draft={editor.draft}
              errors={editor.errors}
              sourceRows={sourceRows}
              countRepeats={countRepeats}
              updateRule={editor.updateRule}
              removeRule={editor.removeRule}
              setRuleQuantity={editor.setRuleQuantity}
              setRuleCount={editor.setRuleCount}
              addRuleFromEvent={editor.addRuleFromEvent}
              addCustomRule={editor.addCustomRule}
            />
          </div>
          </fieldset>
        </form>
      </Modal>
      {guard.confirmation}
      {!toast ? <BuildEditorToasts toasts={editor.toasts} dismiss={editor.dismissToast} /> : null}
    </>
  );
}

function friendlyReclassifyError(error: string): string {
  if (error === "reclassify_queue_failed" || error === "reclassify_unavailable") {
    return "Replay matching is temporarily unavailable. Try again in a moment.";
  }
  return error || "Replay matching is temporarily unavailable. Try again in a moment.";
}

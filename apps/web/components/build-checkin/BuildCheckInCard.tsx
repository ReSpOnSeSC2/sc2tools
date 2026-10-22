"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { ClipboardCheck, Info, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  INELIGIBLE_REASON_COPY,
  mergeIntentUpdate,
  useGameBuildIntent,
  type BuildOption,
  type CheckInSide,
  type GameIntentState,
} from "@/lib/buildIntent";
import { useBuildCheckInRevision } from "./BuildCheckInProvider";
import { BuildPicker } from "./BuildPicker";
import { usePickerRowFocus } from "./focus";
import {
  CheckInNewBuild,
  type NewBuildRequest,
  type NewBuildSaved,
} from "./CheckInNewBuild";
import {
  CheckInNotesEditor,
  useCheckInNotes,
  type CheckInNotesDraft,
} from "./CheckInNotes";
import {
  CheckInStatusBadge,
  DetectedLine,
  ReasonChip,
} from "./CheckInParts";
import { OpponentBuildRow, type PickerSignal } from "./OpponentBuildRow";
import { useCheckInActions, type CheckInActions } from "./useCheckInActions";
import { useNewBuildCheckIn } from "./useNewBuildCheckIn";

type SideSignal = PickerSignal & { side: CheckInSide };

/**
 * BuildCheckInCard — the game page's "which build were you going for?"
 * surface. Eligible games get the full card (planned vs detected, the
 * server's suggestion with Confirm while pending, Change via the picker,
 * "No set build", the opponent's build with its own Change, and notes);
 * a game nobody checked in yet shows a compact "Set planned build" action
 * that expands into the card; an ineligible game gets a one-line reason.
 * Loading never reserves space, so pages for games without a check-in
 * don't jump.
 *
 * Either picker can "Add new build…": the custom-build editor opens on
 * this game's build order and, once saved, the new build becomes this
 * game's check-in for that side. `initialNewBuild` (the `?newBuild=` deep
 * link the desktop app opens) does the same as soon as the game loads.
 */
export function BuildCheckInCard({
  gameId,
  onChanged,
  initialNewBuild = null,
  onNewBuildOpened,
}: {
  gameId: string;
  /** After a successful write, e.g. to refresh the page's game summary. */
  onChanged?: (state: GameIntentState) => void;
  /** Open "Add new build" for this side once the game's check-in loads. */
  initialNewBuild?: CheckInSide | null;
  /** The deep link was acted on (or can't be); e.g. drop it from the URL. */
  onNewBuildOpened?: () => void;
}) {
  const { revision } = useBuildCheckInRevision();
  const request = useGameBuildIntent(gameId, revision);
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState<NewBuildRequest | null>(null);
  const [signal, setSignal] = useState<SideSignal | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const deepLinkHandled = useRef(false);
  const state = request.data;
  const stateRef = useRef(state);
  stateRef.current = state;

  const applyUpdate = (next: GameIntentState) => {
    // PUT responses carry no build lists; keep the ones already loaded.
    void request.mutate((current) => mergeIntentUpdate(current, next), {
      revalidate: false,
    });
    // A write on an unchecked game (notes, the opponent's build) keeps the
    // full card open instead of folding back to the compact action.
    if (next.status === "none") setExpanded(true);
    onChanged?.(next);
  };
  const actions = useCheckInActions(gameId, applyUpdate);
  const notes = useCheckInNotes(state?.notes ?? "");
  const checkInNewBuild = useNewBuildCheckIn(actions);

  const openNewBuild = (side: CheckInSide, query = "") => {
    const current = stateRef.current;
    setCreating({
      gameId,
      side,
      defaultName: query.trim() || undefined,
      myRace: current?.myRace ?? null,
      oppRace: current?.oppRace ?? null,
    });
  };

  const onNewBuildSaved = async (saved: NewBuildSaved) => {
    const game = stateRef.current;
    const notesForWrite = notes.dirty ? notes.draft : undefined;
    const outcome = await checkInNewBuild(saved, game, notesForWrite);
    if (outcome.state) {
      if (notesForWrite !== undefined) notes.markSaved(outcome.state.notes ?? notesForWrite);
      setSignal({ side: saved.side, key: saved.key, open: false, nonce: Date.now() });
      return;
    }
    // The build is saved either way: refresh the lists so it shows up, and
    // open that side's picker on it (selected once the list includes it).
    void request.mutate();
    if (!game?.eligible || outcome.errorCode === "not_eligible") return;
    if (saved.side === "opponent" && !game.opponent) return;
    if (game.status === "none") setExpanded(true);
    setSignal({ side: saved.side, key: saved.key, open: true, nonce: Date.now() });
  };

  useEffect(() => {
    if (!initialNewBuild || deepLinkHandled.current) return;
    if (!state) {
      if (request.error?.status === 404) {
        deepLinkHandled.current = true;
        onNewBuildOpened?.();
      }
      return;
    }
    deepLinkHandled.current = true;
    if (state.eligible && state.status === "none") setExpanded(true);
    openNewBuild(initialNewBuild);
    rootRef.current?.scrollIntoView?.({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    onNewBuildOpened?.();
    // openNewBuild/onNewBuildOpened are fresh each render; the ref guard
    // makes this run once per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNewBuild, state, request.error]);

  const launcher = (
    <CheckInNewBuild
      request={creating}
      onClose={() => setCreating(null)}
      onSaved={(saved) => void onNewBuildSaved(saved)}
    />
  );

  // The compact action stands in for an unchecked game until something on
  // it is set; Cancel folds the expanded card back only when it can.
  const collapsible = state?.status === "none" && !state.opponent?.applied;
  let content: ReactNode;
  if (!state) {
    content =
      !request.error || request.error.status === 404 ? null : (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-dashed border-border px-4 py-3 text-caption text-text-muted"
        >
          <span>Build check-in couldn&apos;t load. {request.error.message}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void request.mutate()}
            iconLeft={<RotateCcw className="h-4 w-4" aria-hidden />}
          >
            Try again
          </Button>
        </div>
      );
  } else if (!state.eligible) {
    content = <IneligibleLine state={state} />;
  } else if (collapsible && !expanded) {
    content = (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-dashed border-border bg-bg-surface px-4 py-3"
        data-testid="build-checkin-compact"
      >
        <p className="flex min-w-0 items-start gap-2 text-caption text-text-muted">
          <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span>
            Went for a different build than the replay shows? Set your planned
            build and this game counts toward it.
            {state.opponent ? " You can correct the opponent's build here too." : null}
          </span>
        </p>
        <Button variant="secondary" size="sm" onClick={() => setExpanded(true)}>
          Set planned build
        </Button>
      </div>
    );
  } else {
    content = (
      <CheckInPanel
        key={state.gameId}
        state={state}
        actions={actions}
        notes={notes}
        signal={signal}
        optionsLoading={request.isValidating}
        onRefetch={() => void request.mutate()}
        onCollapse={collapsible && expanded ? () => setExpanded(false) : undefined}
        onAddNew={openNewBuild}
        editorOpen={creating !== null}
      />
    );
  }

  return (
    <>
      {content ? (
        <div ref={rootRef} className="scroll-mt-20">
          {content}
        </div>
      ) : null}
      {launcher}
    </>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function IneligibleLine({ state }: { state: GameIntentState }) {
  const reason = state.ineligibleReason;
  const planned = state.status === "confirmed" ? state.build : null;
  return (
    <div
      className="flex items-start gap-2 rounded-xl border border-border bg-bg-elevated/40 px-4 py-2.5 text-caption text-text-muted"
      data-testid="build-checkin-ineligible"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-text-dim" aria-hidden />
      <p>
        <span className="font-semibold text-text">Build check-in unavailable.</span>{" "}
        {reason ? INELIGIBLE_REASON_COPY[reason] : "This game can't take a check-in."}
        {planned ? (
          <>
            {" "}You planned <span className="font-semibold text-text">{planned.name}</span>;
            it isn&apos;t counted.
          </>
        ) : null}
      </p>
    </div>
  );
}

function CheckInPanel({
  state,
  actions,
  notes,
  signal,
  optionsLoading,
  onRefetch,
  onCollapse,
  onAddNew,
  editorOpen,
}: {
  state: GameIntentState;
  actions: CheckInActions;
  notes: CheckInNotesDraft;
  signal: SideSignal | null;
  optionsLoading: boolean;
  onRefetch: () => void;
  /** Present while a status-none game is expanded from the compact action. */
  onCollapse?: () => void;
  onAddNew: (side: CheckInSide, query: string) => void;
  /** The build editor dialog is open over the page. */
  editorOpen: boolean;
}) {
  const titleId = useId();
  const notesForWrite = () => (notes.dirty ? notes.draft : undefined);

  const afterWrite = (errorCode: string | null) => {
    // The game's eligibility or existence changed underneath us.
    if (errorCode === "not_eligible" || errorCode === "not_found") onRefetch();
  };

  const saveOpponent = async (key: string | null, name: string | null) => {
    const pendingNotes = notesForWrite();
    const outcome = await actions.setOpponent(key, name, pendingNotes);
    if (outcome.state) {
      if (pendingNotes !== undefined) notes.markSaved(outcome.state.notes ?? pendingNotes);
      return true;
    }
    afterWrite(outcome.errorCode);
    return false;
  };

  const saveNotes = async () => {
    const outcome = await actions.saveNotes(notes.draft);
    if (outcome.state) notes.markSaved(outcome.state.notes ?? notes.draft);
    else afterWrite(outcome.errorCode);
  };

  const actionMessage =
    actions.message && actions.message.kind !== "notes" ? actions.message : null;
  const notesMessage =
    actions.message && actions.message.kind === "notes" ? actions.message : null;

  return (
    <Card
      variant={state.status === "pending" ? "feature" : "default"}
      padded={false}
      aria-labelledby={titleId}
      data-testid="build-checkin-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-accent" aria-hidden />
            <h2
              id={titleId}
              className="text-caption font-semibold uppercase tracking-wider text-text"
            >
              Build check-in
            </h2>
            <CheckInStatusBadge status={state.status} />
          </div>
          <p className="mt-1 text-caption text-text-muted">
            {state.status === "pending"
              ? "Which build were you going for? Confirming counts this game toward that build's record, even if the game went sideways."
              : "A confirmed check-in counts this game toward the build you planned, whatever the replay was classified as."}
          </p>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <YourBuildRow
          state={state}
          actions={actions}
          notes={notes}
          signal={signal?.side === "you" ? signal : null}
          optionsLoading={optionsLoading}
          onRefetch={onRefetch}
          onCollapse={onCollapse}
          onAddNew={(query) => onAddNew("you", query)}
          afterWrite={afterWrite}
          editorOpen={editorOpen}
        />

        {state.opponent ? (
          <OpponentBuildRow
            opponent={state.opponent}
            matchup={state.matchup}
            busy={actions.busy}
            optionsLoading={optionsLoading}
            onSave={saveOpponent}
            onRetry={onRefetch}
            onAddNew={(query) => onAddNew("opponent", query)}
            signal={signal?.side === "opponent" ? signal : null}
            editorOpen={editorOpen}
          />
        ) : null}

        <p
          role={actionMessage?.error ? "alert" : "status"}
          aria-live="polite"
          className={[
            "text-caption",
            actionMessage?.error ? "text-danger" : "text-success",
            actionMessage ? "" : "sr-only",
          ].join(" ")}
        >
          {actionMessage?.text ?? ""}
        </p>

        <div className="border-t border-border pt-4">
          <CheckInNotesEditor
            notes={notes}
            saving={actions.busy === "notes"}
            disabled={
              actions.busy === "confirm" ||
              actions.busy === "skip" ||
              actions.busy === "opponent"
            }
            status={notesMessage?.text ?? ""}
            statusIsError={Boolean(notesMessage?.error)}
            onSave={() => void saveNotes()}
            onEdit={() => {
              if (notesMessage) actions.clearMessage();
            }}
          />
        </div>
      </div>
    </Card>
  );
}

/** The player's own side: detected label, suggestion or planned build, and the picker. */
function YourBuildRow({
  state,
  actions,
  notes,
  signal,
  optionsLoading,
  onRefetch,
  onCollapse,
  onAddNew,
  afterWrite,
  editorOpen,
}: {
  state: GameIntentState;
  actions: CheckInActions;
  notes: CheckInNotesDraft;
  signal: PickerSignal | null;
  optionsLoading: boolean;
  onRefetch: () => void;
  onCollapse?: () => void;
  onAddNew: (query: string) => void;
  afterWrite: (errorCode: string | null) => void;
  editorOpen: boolean;
}) {
  const suggestion = state.suggestion;
  const [picking, setPicking] = useState(
    Boolean(onCollapse) || (state.status === "pending" && !suggestion),
  );
  // Focus the search box only when the player opened the picker, never
  // on page load.
  const [focusPicker, setFocusPicker] = useState(Boolean(onCollapse));
  const [selectedKey, setSelectedKey] = useState<string | null>(
    state.status === "confirmed" ? state.build?.key ?? null : suggestion?.key ?? null,
  );
  const options = state.options;
  const selected: BuildOption | null =
    options?.find((option) => option.key === selectedKey) ?? null;
  const busy = actions.busy !== null;
  const { changeRef, rowRef, returnOnClose, returnToPickerIfLost } = usePickerRowFocus({
    picking,
    busy,
    editorOpen,
  });

  useEffect(() => {
    if (!signal) return;
    setSelectedKey(signal.key);
    // Closing from outside (the new build was checked in) unmounts the
    // picker's "Add new build…" button that opened the editor; reopening
    // after a failed check-in finds that button disabled, or gone.
    if (signal.open) returnToPickerIfLost();
    else returnOnClose();
    setPicking(signal.open);
  }, [signal, returnOnClose, returnToPickerIfLost]);

  // The picker's controls unmount when it closes: "Change…" takes focus
  // back so keyboard users keep their place.
  const closePicker = () => {
    if (picking) returnOnClose();
    setPicking(false);
  };

  const confirm = async (key: string, name: string) => {
    const pendingNotes = notes.dirty ? notes.draft : undefined;
    const outcome = await actions.confirm(key, name, pendingNotes);
    if (outcome.state) {
      if (pendingNotes !== undefined) notes.markSaved(outcome.state.notes ?? pendingNotes);
      closePicker();
    } else {
      afterWrite(outcome.errorCode);
    }
  };

  const skip = async () => {
    const pendingNotes = notes.dirty ? notes.draft : undefined;
    const outcome = await actions.skip(pendingNotes);
    if (outcome.state) {
      if (pendingNotes !== undefined) notes.markSaved(outcome.state.notes ?? pendingNotes);
      closePicker();
    } else {
      afterWrite(outcome.errorCode);
    }
  };

  const cancelPicking = () => {
    if (onCollapse) {
      onCollapse();
      return;
    }
    closePicker();
    setSelectedKey(
      state.status === "confirmed" ? state.build?.key ?? null : suggestion?.key ?? null,
    );
  };

  return (
    <div ref={rowRef} role="group" aria-label="Your build" className="space-y-4">
      <DetectedLine
        detected={state.detected?.name}
        executed={state.status === "confirmed" && state.executed}
      />

      {picking ? (
        <div className="space-y-3">
          {state.status === "pending" && !suggestion ? (
            <p className="text-caption text-text">Pick the build you were going for.</p>
          ) : null}
          <BuildPicker
            options={options}
            loading={options === undefined && optionsLoading}
            error={
              options === undefined && !optionsLoading
                ? "The build list couldn't load."
                : null
            }
            onRetry={onRefetch}
            value={selectedKey}
            onChange={(option) => setSelectedKey(option.key)}
            rolledKey={state.randomizer?.key ?? null}
            usualKey={state.usualKey ?? null}
            suggestedKey={suggestion?.key ?? null}
            label="Build you went for"
            onAddNew={onAddNew}
            autoFocus={focusPicker}
            disabled={busy}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={actions.busy === "confirm"}
              disabled={!selected || busy}
              onClick={() => selected && void confirm(selected.key, selected.name)}
            >
              {selected ? `Confirm ${selected.name}` : "Confirm"}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={cancelPicking}>
              Cancel
            </Button>
            {state.status === "pending" ? (
              <Button
                variant="ghost"
                size="sm"
                loading={actions.busy === "skip"}
                disabled={busy}
                onClick={() => void skip()}
              >
                No set build
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <StatusSummary
          state={state}
          busy={actions.busy}
          changeRef={changeRef}
          onConfirmSuggestion={() =>
            suggestion && void confirm(suggestion.key, suggestion.name)
          }
          onChange={() => {
            setFocusPicker(true);
            setPicking(true);
          }}
          onSkip={() => void skip()}
        />
      )}
    </div>
  );
}

function StatusSummary({
  state,
  busy,
  changeRef,
  onConfirmSuggestion,
  onChange,
  onSkip,
}: {
  state: GameIntentState;
  busy: CheckInActions["busy"];
  /** Whichever "Change…" / "Set planned build" button is shown. */
  changeRef: Ref<HTMLButtonElement>;
  onConfirmSuggestion: () => void;
  onChange: () => void;
  onSkip: () => void;
}) {
  const disabled = busy !== null;
  const suggestion = state.suggestion;

  if (state.status === "pending" && suggestion) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border-2 border-line bg-bg-elevated/50 px-3 py-2.5">
          <p className="text-micro font-bold uppercase tracking-[0.12em] text-text-dim">
            Suggested
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-display text-body-lg font-bold text-text">
              {suggestion.name}
            </span>
            <ReasonChip suggestion={suggestion} matchup={state.matchup} />
          </div>
          {state.randomizerDeviated && state.randomizer ? (
            <p className="mt-1 text-caption text-text-muted">
              Your randomizer rolled{" "}
              <span className="font-semibold text-text">{state.randomizer.name}</span>, but
              the replay looks different. Pick what you actually went for.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            loading={busy === "confirm"}
            disabled={disabled}
            onClick={onConfirmSuggestion}
          >
            Confirm
          </Button>
          <Button
            ref={changeRef}
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={onChange}
          >
            Change…
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={busy === "skip"}
            disabled={disabled}
            onClick={onSkip}
          >
            No set build
          </Button>
        </div>
      </div>
    );
  }

  if (state.status === "confirmed" && state.build) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border-2 border-line bg-bg-elevated/50 px-3 py-2.5">
          <p className="text-micro font-bold uppercase tracking-[0.12em] text-text-dim">
            Planned build
          </p>
          <p className="mt-1 font-display text-body-lg font-bold text-text">
            {state.build.name}
          </p>
          <p className="mt-0.5 text-caption text-text-muted">
            {state.applied
              ? "This game counts toward it in your stats."
              : "Saved, but this game doesn't count toward it."}
            {state.build.deleted ? " The build has since been deleted from your library." : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            ref={changeRef}
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={onChange}
          >
            Change…
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={busy === "skip"}
            disabled={disabled}
            onClick={onSkip}
          >
            No set build
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-caption text-text-muted">
        {state.status === "skipped"
          ? "No set build. This game keeps the replay's own label."
          : "No planned build yet."}
      </p>
      <Button
        ref={changeRef}
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={onChange}
      >
        Set planned build
      </Button>
    </div>
  );
}

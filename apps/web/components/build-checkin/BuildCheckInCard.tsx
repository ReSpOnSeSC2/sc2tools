"use client";

import { useId, useState } from "react";
import { ClipboardCheck, Info, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  INELIGIBLE_REASON_COPY,
  useGameBuildIntent,
  type BuildOption,
  type GameIntentState,
} from "@/lib/buildIntent";
import { useBuildCheckInRevision } from "./BuildCheckInProvider";
import { BuildPicker } from "./BuildPicker";
import { CheckInNotesEditor, useCheckInNotes } from "./CheckInNotes";
import {
  CheckInStatusBadge,
  DetectedLine,
  ReasonChip,
} from "./CheckInParts";
import { useCheckInActions } from "./useCheckInActions";

/**
 * BuildCheckInCard — the game page's "which build were you going for?"
 * surface. Eligible games get the full card (planned vs detected, the
 * server's suggestion with Confirm while pending, Change via the picker,
 * "No set build" and notes); a game nobody checked in yet shows a compact
 * "Set planned build" action that expands into the card; an ineligible game
 * gets a one-line reason. Loading never reserves space, so pages for games
 * without a check-in don't jump.
 */
export function BuildCheckInCard({
  gameId,
  onChanged,
}: {
  gameId: string;
  /** After a successful write, e.g. to refresh the page's game summary. */
  onChanged?: (state: GameIntentState) => void;
}) {
  const { revision } = useBuildCheckInRevision();
  const request = useGameBuildIntent(gameId, revision);
  const [expanded, setExpanded] = useState(false);
  const state = request.data;

  if (!state) {
    if (!request.error || request.error.status === 404) return null;
    return (
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-dashed border-border px-4 py-3 text-caption text-text-muted"
      >
        <span>Build check-in couldn't load. {request.error.message}</span>
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
  }

  if (!state.eligible) return <IneligibleLine state={state} />;

  if (state.status === "none" && !expanded) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-dashed border-border bg-bg-surface px-4 py-3"
        data-testid="build-checkin-compact"
      >
        <p className="flex min-w-0 items-start gap-2 text-caption text-text-muted">
          <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span>
            Went for a different build than the replay shows? Set your planned
            build and this game counts toward it.
          </span>
        </p>
        <Button variant="secondary" size="sm" onClick={() => setExpanded(true)}>
          Set planned build
        </Button>
      </div>
    );
  }

  const applyUpdate = (next: GameIntentState) => {
    // PUT responses carry no build list; keep the one already loaded.
    void request.mutate(
      (current) => ({
        ...next,
        options: next.options ?? current?.options,
        usualKey: next.usualKey ?? current?.usualKey ?? null,
      }),
      { revalidate: false },
    );
    onChanged?.(next);
  };

  return (
    <CheckInPanel
      key={state.gameId}
      state={state}
      optionsLoading={request.isValidating}
      onUpdated={applyUpdate}
      onRefetch={() => void request.mutate()}
      onCollapse={state.status === "none" ? () => setExpanded(false) : undefined}
    />
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
            it isn't counted.
          </>
        ) : null}
      </p>
    </div>
  );
}

function CheckInPanel({
  state,
  optionsLoading,
  onUpdated,
  onRefetch,
  onCollapse,
}: {
  state: GameIntentState;
  optionsLoading: boolean;
  onUpdated: (next: GameIntentState) => void;
  onRefetch: () => void;
  /** Present while a status-none game is expanded from the compact action. */
  onCollapse?: () => void;
}) {
  const titleId = useId();
  const actions = useCheckInActions(state.gameId, onUpdated);
  const notes = useCheckInNotes(state.notes ?? "");
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
  const notesForWrite = notes.dirty ? notes.draft : undefined;

  const afterWrite = (errorCode: string | null) => {
    // The game's eligibility or existence changed underneath us.
    if (errorCode === "not_eligible" || errorCode === "not_found") onRefetch();
  };

  const confirm = async (key: string, name: string) => {
    const outcome = await actions.confirm(key, name, notesForWrite);
    if (outcome.state) {
      if (notesForWrite !== undefined) notes.markSaved(outcome.state.notes ?? notesForWrite);
      setPicking(false);
    } else {
      afterWrite(outcome.errorCode);
    }
  };

  const skip = async () => {
    const outcome = await actions.skip(notesForWrite);
    if (outcome.state) {
      if (notesForWrite !== undefined) notes.markSaved(outcome.state.notes ?? notesForWrite);
      setPicking(false);
    } else {
      afterWrite(outcome.errorCode);
    }
  };

  const saveNotes = async () => {
    const outcome = await actions.saveNotes(notes.draft);
    if (outcome.state) notes.markSaved(outcome.state.notes ?? notes.draft);
    else afterWrite(outcome.errorCode);
  };

  const cancelPicking = () => {
    if (onCollapse) {
      onCollapse();
      return;
    }
    setPicking(false);
    setSelectedKey(
      state.status === "confirmed" ? state.build?.key ?? null : suggestion?.key ?? null,
    );
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
            disabled={actions.busy === "confirm" || actions.busy === "skip"}
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

function StatusSummary({
  state,
  busy,
  onConfirmSuggestion,
  onChange,
  onSkip,
}: {
  state: GameIntentState;
  busy: ReturnType<typeof useCheckInActions>["busy"];
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
          <Button variant="secondary" size="sm" disabled={disabled} onClick={onChange}>
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
          <Button variant="secondary" size="sm" disabled={disabled} onClick={onChange}>
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
      <Button variant="secondary" size="sm" disabled={disabled} onClick={onChange}>
        Set planned build
      </Button>
    </div>
  );
}

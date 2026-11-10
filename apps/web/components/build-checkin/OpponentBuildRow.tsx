"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  effectiveOpponentBuild,
  opponentCurrentKey,
  type BuildOption,
  type OpponentIntentState,
} from "@/lib/buildIntent";
import { BuildPicker } from "./BuildPicker";
import { BuildNameLink, ReasonChip } from "./CheckInParts";
import { CorrectedBadge } from "./PlannedBadge";
import { usePickerRowFocus } from "./focus";
import type { CheckInBusy } from "./useCheckInActions";

/** Open (or close) a side's picker from outside, e.g. after "Add new build". */
export interface PickerSignal {
  key: string;
  open: boolean;
  /** Changes on every request so the same key can be signalled twice. */
  nonce: number;
}

export const OPPONENT_GROUP_TITLES = { yours: "Faced before", all: "All builds" } as const;

/**
 * OpponentBuildRow — the check-in card's compact "Opponent's build: X"
 * line. The replay classifier names the opponent's build; when it got it
 * wrong the player picks the right one (or adds it as a new build), and
 * the game's opponent label follows that correction in their own stats.
 * "Use replay's label" undoes a correction.
 */
export function OpponentBuildRow({
  opponent,
  matchup,
  busy,
  optionsLoading,
  onSave,
  onRetry,
  onAddNew,
  signal,
  editorOpen = false,
}: {
  opponent: OpponentIntentState;
  matchup: string | null;
  busy: CheckInBusy;
  optionsLoading: boolean;
  /** `null` = go back to the replay's label; resolves true on success. */
  onSave: (key: string | null, name: string | null) => Promise<boolean>;
  onRetry: () => void;
  onAddNew: (query: string) => void;
  signal?: PickerSignal | null;
  /** The build editor dialog is open over the page. */
  editorOpen?: boolean;
}) {
  const headingId = useId();
  const currentKey = opponentCurrentKey(opponent);
  const { label, corrected } = effectiveOpponentBuild(opponent, null);
  const [picking, setPicking] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(currentKey);
  const options = opponent.options;
  const disabled = busy !== null;
  const { changeRef, rowRef, returnOnClose, returnToPickerIfLost } = usePickerRowFocus({
    picking,
    busy: disabled,
    editorOpen,
  });
  const suggestion = opponent.suggestion;
  const canReset = opponent.status === "confirmed" || opponent.applied;

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

  const save = async (key: string | null, name: string | null) => {
    if (await onSave(key, name)) {
      returnOnClose();
      setPicking(false);
      setSelectedKey(key ?? opponent.detected?.key ?? null);
    }
  };

  const cancel = () => {
    returnOnClose();
    setPicking(false);
    setSelectedKey(currentKey);
  };

  return (
    <div
      ref={rowRef}
      role="group"
      aria-labelledby={headingId}
      className="space-y-2 border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p id={headingId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-muted">
            <span>Opponent&apos;s build:</span>
            <span className="font-semibold text-text">{label?.trim() || "Unknown"}</span>
            {corrected ? <CorrectedBadge detected={corrected.detected} /> : null}
            {opponent.applied && opponent.build?.deleted ? (
              <span className="text-text-dim">· deleted from your library</span>
            ) : null}
          </p>
          {!opponent.applied && suggestion && suggestion.key !== currentKey ? (
            <p className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
              Closest match
              <BuildNameLink build={suggestion} />
              <ReasonChip suggestion={suggestion} matchup={matchup} />
            </p>
          ) : null}
        </div>
        {picking ? null : (
          <Button
            ref={changeRef}
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setSelectedKey(currentKey);
              setPicking(true);
            }}
            aria-label="Change the opponent's build"
          >
            Change…
          </Button>
        )}
      </div>

      {picking ? (
        <OpponentBuildPicker
          options={options}
          loading={options === undefined && optionsLoading}
          error={
            options === undefined && !optionsLoading
              ? "The opponent build list couldn't load."
              : null
          }
          onRetry={onRetry}
          value={selectedKey}
          onChange={setSelectedKey}
          currentKey={currentKey}
          suggestedKey={suggestion?.key ?? null}
          matchup={matchup}
          busy={busy}
          canReset={canReset}
          onAddNew={onAddNew}
          onSave={(key, name) => void save(key, name)}
          onCancel={cancel}
        />
      ) : null}
    </div>
  );
}

/**
 * OpponentBuildPicker — the opponent's build list with Save, Cancel and
 * "Use replay's label", shared by the game page's opponent row and the
 * check-in queue. The list's own "Add new build…" opens the editor.
 */
export function OpponentBuildPicker({
  options,
  loading,
  error,
  onRetry,
  value,
  onChange,
  currentKey,
  suggestedKey,
  matchup,
  busy,
  disabled: blocked = false,
  canReset,
  onAddNew,
  onSave,
  onCancel,
}: {
  options: BuildOption[] | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  value: string | null;
  onChange: (key: string) => void;
  /** The build the game counts as now; saving it again is pointless. */
  currentKey: string | null;
  suggestedKey: string | null;
  matchup: string | null;
  busy: CheckInBusy;
  /** Something else is writing (e.g. the queue's "Confirm all suggested"). */
  disabled?: boolean;
  /** A correction is in place, so "Use replay's label" can undo it. */
  canReset: boolean;
  onAddNew: (query: string) => void;
  /** `null` = go back to the replay's label. */
  onSave: (key: string | null, name: string | null) => void;
  onCancel: () => void;
}) {
  const selected = options?.find((option) => option.key === value) ?? null;
  const disabled = blocked || busy !== null;
  return (
    <div className="space-y-3">
      <BuildPicker
        options={options}
        loading={loading}
        error={error}
        onRetry={onRetry}
        value={value}
        onChange={(option) => onChange(option.key)}
        suggestedKey={suggestedKey}
        label={matchup ? `Opponent's build in ${matchup}` : "Opponent's build"}
        groupTitles={OPPONENT_GROUP_TITLES}
        searchPlaceholder="Search opponent builds…"
        onAddNew={onAddNew}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- User-opened picker; Cancel restores focus.
        autoFocus
        disabled={disabled}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          loading={busy === "opponent"}
          disabled={!selected || disabled || selected.key === currentKey}
          onClick={() => selected && onSave(selected.key, selected.name)}
        >
          {selected ? `Save ${selected.name}` : "Save"}
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
          Cancel
        </Button>
        {canReset ? (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onSave(null, null)}>
            Use replay&apos;s label
          </Button>
        ) : null}
      </div>
    </div>
  );
}

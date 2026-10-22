"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  effectiveOpponentBuild,
  opponentCurrentKey,
  type OpponentIntentState,
} from "@/lib/buildIntent";
import { BuildPicker } from "./BuildPicker";
import { ReasonChip } from "./CheckInParts";
import { CorrectedBadge } from "./PlannedBadge";
import { focusWasLost } from "./focus";
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
}) {
  const headingId = useId();
  const currentKey = opponentCurrentKey(opponent);
  const { label, corrected } = effectiveOpponentBuild(opponent, null);
  const [picking, setPicking] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(currentKey);
  const changeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const options = opponent.options;
  const selected = options?.find((option) => option.key === selectedKey) ?? null;
  const disabled = busy !== null;
  const suggestion = opponent.suggestion;
  const canReset = opponent.status === "confirmed" || opponent.applied;

  useEffect(() => {
    if (!signal) return;
    setSelectedKey(signal.key);
    // Closing from outside (the new build was checked in) unmounts the
    // picker's "Add new build…" button that opened the editor.
    if (!signal.open) returnFocus.current = true;
    setPicking(signal.open);
  }, [signal]);

  // The "Change…" button unmounts while the picker is open; give focus
  // back to it when the picker closes from inside.
  useEffect(() => {
    if (picking || !returnFocus.current) return;
    returnFocus.current = false;
    if (focusWasLost()) changeRef.current?.focus();
  }, [picking]);

  const save = async (key: string | null, name: string | null) => {
    if (await onSave(key, name)) {
      returnFocus.current = true;
      setPicking(false);
      setSelectedKey(key ?? opponent.detected?.key ?? null);
    }
  };

  const cancel = () => {
    returnFocus.current = true;
    setPicking(false);
    setSelectedKey(currentKey);
  };

  return (
    <div
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
              <span className="font-semibold text-text">{suggestion.name}</span>
              <ReasonChip suggestion={suggestion} matchup={matchup} />
            </p>
          ) : null}
        </div>
        {picking ? null : (
          <Button
            ref={changeRef}
            data-checkin-change="opponent"
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
        <div className="space-y-3">
          <BuildPicker
            options={options}
            loading={options === undefined && optionsLoading}
            error={
              options === undefined && !optionsLoading
                ? "The opponent build list couldn't load."
                : null
            }
            onRetry={onRetry}
            value={selectedKey}
            onChange={(option) => setSelectedKey(option.key)}
            suggestedKey={suggestion?.key ?? null}
            label={matchup ? `Opponent's build in ${matchup}` : "Opponent's build"}
            groupTitles={OPPONENT_GROUP_TITLES}
            searchPlaceholder="Search opponent builds…"
            onAddNew={onAddNew}
            autoFocus
            disabled={disabled}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={busy === "opponent"}
              disabled={!selected || disabled || selected.key === currentKey}
              onClick={() => selected && void save(selected.key, selected.name)}
            >
              {selected ? `Save ${selected.name}` : "Save"}
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={cancel}>
              Cancel
            </Button>
            {canReset ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => void save(null, null)}
              >
                Use replay&apos;s label
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

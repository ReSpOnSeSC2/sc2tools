"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  buildIntentErrorMessage,
  effectiveOpponentBuild,
  opponentCurrentKey,
  useBuildOptions,
  type OpponentIntentState,
} from "@/lib/buildIntent";
import { BuildNameLink } from "./CheckInParts";
import { OpponentBuildPicker, type PickerSignal } from "./OpponentBuildRow";
import { CorrectedBadge } from "./PlannedBadge";
import type { CheckInActions } from "./useCheckInActions";

/** The correction a queue change replaced: `key: null` = the replay's own label. */
interface OpponentUndo {
  key: string | null;
  name: string | null;
  /** The outcome line of the change being undone. */
  text: string;
}

/**
 * The queue's "Opponent: X" line: Change… opens the shared opponent picker
 * (its list loads on demand), "Add opponent build…" opens the editor, and
 * after a change an Undo puts the previous correction back until the
 * queue closes.
 */
export function QueueOpponentLine({
  opponent,
  matchup,
  revision,
  actions,
  disabled,
  signal = null,
  onAddNew,
  onNavigate,
}: {
  opponent: OpponentIntentState;
  matchup: string | null;
  revision: number;
  actions: CheckInActions;
  /** A write for this game (or "Confirm all suggested") is running. */
  disabled: boolean;
  /** Opens the picker on a build, e.g. one just added that didn't check in. */
  signal?: PickerSignal | null;
  onAddNew: (query: string) => void;
  onNavigate: () => void;
}) {
  // A saved change shows at once; the next list refresh replaces it.
  const [latest, setLatest] = useState<{ base: OpponentIntentState; value: OpponentIntentState } | null>(null);
  const shown = latest && latest.base === opponent ? latest.value : opponent;
  const currentKey = opponentCurrentKey(shown);
  const [picking, setPicking] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(currentKey);
  const [undo, setUndo] = useState<OpponentUndo | null>(null);
  const options = useBuildOptions(picking ? matchup : null, { side: "opponent", revision });
  const changeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const { label, corrected } = effectiveOpponentBuild(shown, null);

  useEffect(() => {
    if (!signal) return;
    setSelectedKey(signal.key);
    setPicking(signal.open);
  }, [signal]);

  useEffect(() => {
    if (picking || !returnFocus.current) return;
    returnFocus.current = false;
    changeRef.current?.focus();
  }, [picking]);

  const write = async (key: string | null, name: string | null) => {
    const outcome = await actions.setOpponent(key, name);
    if (outcome.state?.opponent) setLatest({ base: opponent, value: outcome.state.opponent });
    return outcome;
  };

  const save = async (key: string | null, name: string | null) => {
    const previous = shown.status === "confirmed" && shown.build
      ? { key: shown.build.key, name: shown.build.name }
      : { key: null, name: null };
    const outcome = await write(key, name);
    if (!outcome.state) return;
    setUndo({ ...previous, text: outcome.text ?? "Opponent's build saved" });
    returnFocus.current = true;
    setPicking(false);
  };

  const revert = async () => {
    if (!undo) return;
    const outcome = await write(undo.key, undo.name);
    if (!outcome.state) return;
    setUndo(null);
    returnFocus.current = true;
  };

  return (
    <div className="space-y-2 text-caption text-text-muted">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          Opponent:{" "}
          {shown.applied && shown.build ? (
            <BuildNameLink build={shown.build} onNavigate={onNavigate} />
          ) : (
            <span className="font-semibold text-text">{label?.trim() || "Unknown"}</span>
          )}
        </span>
        {corrected ? <CorrectedBadge detected={corrected.detected} /> : null}
        {picking ? null : (
          <Button
            ref={changeRef}
            variant="ghost"
            size="sm"
            className="min-h-11"
            disabled={disabled}
            aria-label="Change the opponent's build"
            onClick={() => {
              setSelectedKey(currentKey);
              setPicking(true);
            }}
          >
            Change…
          </Button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAddNew("")}
          className="inline-flex min-h-11 items-center gap-1 rounded px-1 font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add opponent build…
          <span className="sr-only"> from the opponent&apos;s replay</span>
        </button>
      </div>
      {undo && !picking ? (
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="font-semibold text-success">{undo.text}</span>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            loading={actions.busy === "opponent"}
            disabled={disabled}
            iconLeft={<Undo2 className="h-4 w-4" aria-hidden />}
            aria-label="Undo the opponent's build change"
            onClick={() => void revert()}
          >
            Undo
          </Button>
        </div>
      ) : null}
      {picking ? (
        <OpponentBuildPicker
          options={options.data?.builds}
          loading={options.isLoading || (!options.data && !options.error)}
          error={options.error ? buildIntentErrorMessage(options.error) : null}
          onRetry={() => void options.mutate()}
          value={selectedKey}
          onChange={setSelectedKey}
          currentKey={currentKey}
          suggestedKey={shown.suggestion?.key ?? null}
          matchup={matchup}
          busy={actions.busy}
          disabled={disabled}
          canReset={shown.status === "confirmed" || shown.applied}
          onAddNew={onAddNew}
          onSave={(key, name) => void save(key, name)}
          onCancel={() => {
            returnFocus.current = true;
            setPicking(false);
          }}
        />
      ) : null}
    </div>
  );
}

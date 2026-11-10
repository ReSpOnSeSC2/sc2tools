"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, ClipboardCheck, Plus, Undo2 } from "lucide-react";
import { GameAnalysisLink } from "@/components/analyzer/GameAnalysisLink";
import { resultLabel } from "@/components/analyzer/game/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { fmtAgo, fmtMinutes } from "@/lib/format";
import {
  buildIntentErrorMessage,
  useBuildOptions,
  type CheckInSide,
  type GameIntentState,
} from "@/lib/buildIntent";
import { BuildPicker } from "./BuildPicker";
import { BuildNameLink, DetectedLine, ReasonChip } from "./CheckInParts";
import type { PickerSignal } from "./OpponentBuildRow";
import { QueueOpponentLine } from "./QueueOpponentLine";
import { useCheckInActions } from "./useCheckInActions";

/** Open a side's picker from outside, e.g. after "Add new build" failed to check in. */
export type QueueSignal = PickerSignal & { side: CheckInSide };

const LINK_BUTTON = [
  "inline-flex min-h-11 items-center gap-1 rounded px-1 font-semibold text-accent hover:underline",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
  "disabled:cursor-not-allowed disabled:opacity-50",
].join(" ");

/**
 * One game of the check-in queue: Confirm <suggestion> / Change… (or
 * "Pick build…" without a suggestion) / No set build, the opponent's build
 * with its own picker, and — once decided — the outcome with Undo until
 * the queue closes.
 */
export function QueueItem({
  item,
  revision,
  outcome,
  batchError,
  batchRunning,
  signal,
  onSignalHandled,
  onNavigate,
  onCreate,
  onDecided,
  onReopened,
}: {
  item: GameIntentState;
  revision: number;
  /** The outcome line once this queue decided the game; null while it waits. */
  outcome: string | null;
  /** What went wrong when "Confirm all suggested" reached this game. */
  batchError: string | null;
  /** "Confirm all suggested" is running; every game waits its turn. */
  batchRunning: boolean;
  signal: QueueSignal | null;
  /** The signal is applied once; a remount must not apply it again. */
  onSignalHandled: () => void;
  /** A link out of the queue was followed (Open game, a build page). */
  onNavigate: () => void;
  onCreate: (side: CheckInSide, query: string) => void;
  onDecided: (state: GameIntentState, text: string) => void;
  onReopened: (state: GameIntentState) => void;
}) {
  const actions = useCheckInActions(item.gameId);
  const [picking, setPicking] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(item.suggestion?.key ?? null);
  const options = useBuildOptions(picking ? item.matchup : null, { revision });
  const builds = options.data?.builds;
  const selected = builds?.find((option) => option.key === selectedKey) ?? null;
  const suggestion = item.suggestion;
  const done = outcome !== null;
  const writing = actions.busy !== null || batchRunning;
  const busy = writing || done;
  const titleId = useId();
  const doneId = useId();
  const pickRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const focusAfter = useRef<"pick" | "done" | "primary" | null>(null);
  const [opponentSignal, setOpponentSignal] = useState<PickerSignal | null>(null);

  useEffect(() => {
    if (!signal) return;
    if (signal.side === "opponent") {
      setOpponentSignal(signal);
    } else {
      setSelectedKey(signal.key);
      setPicking(signal.open);
    }
    onSignalHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per signal
  }, [signal]);

  // Focus never falls out of the dialog when the control that had it
  // unmounts: Cancel returns it to the button that opened the picker, a
  // decision moves it to the outcome line, Undo to the primary action.
  useEffect(() => {
    const target = focusAfter.current;
    if (!target || picking || (target === "done") !== done) return;
    focusAfter.current = null;
    if (target === "done") doneRef.current?.focus({ preventScroll: true });
    else if (target === "primary" && confirmRef.current) confirmRef.current.focus();
    else pickRef.current?.focus();
  }, [picking, done]);

  const confirm = async (key: string, name: string) => {
    focusAfter.current = "done";
    const result = await actions.confirm(key, name);
    if (result.state) {
      setPicking(false);
      onDecided(result.state, result.text ?? `Counted toward ${name}`);
    } else {
      focusAfter.current = null;
    }
  };
  const skip = async () => {
    focusAfter.current = "done";
    const result = await actions.skip();
    if (result.state) {
      setPicking(false);
      onDecided(result.state, result.text ?? "Marked as no set build");
    } else {
      focusAfter.current = null;
    }
  };
  const undo = async () => {
    const result = await actions.reopen();
    if (!result.state) return;
    focusAfter.current = "primary";
    setSelectedKey(result.state.suggestion?.key ?? item.suggestion?.key ?? null);
    onReopened(result.state);
  };
  const cancel = () => {
    focusAfter.current = "pick";
    setPicking(false);
  };

  return (
    <li
      aria-labelledby={titleId}
      aria-busy={actions.busy !== null || undefined}
      className={[
        "rounded-xl border-2 border-line bg-bg-surface p-3 shadow-hard",
        done ? "opacity-80" : "",
      ].join(" ")}
      data-testid="build-checkin-queue-item"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p id={titleId} className="flex flex-wrap items-center gap-2 text-caption">
            <QueueResultBadge result={item.result} />
            <span className="font-display font-bold text-text">{item.matchup ?? "1v1"}</span>
            {item.oppName ? (
              <span className="max-w-[16ch] truncate text-text-muted" title={item.oppName}>
                vs {item.oppName}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-micro text-text-dim">
            {[item.map, item.durationSec ? fmtMinutes(item.durationSec) : null, fmtAgo(item.date)]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <GameAnalysisLink
          gameId={item.gameId}
          onClick={onNavigate}
          className="inline-flex min-h-11 items-center gap-1 rounded px-1 text-caption font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Open game
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </GameAnalysisLink>
      </div>

      <div className="mt-2 space-y-1">
        {suggestion ? (
          <p className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
            Suggested
            <BuildNameLink build={suggestion} onNavigate={onNavigate} />
            <ReasonChip suggestion={suggestion} matchup={item.matchup} />
          </p>
        ) : (
          <p className="text-caption text-text-muted">
            No suggestion yet. Pick the build you went for.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <DetectedLine detected={item.detected?.name} onNavigate={onNavigate} />
          <button
            type="button"
            disabled={busy || !item.matchup}
            onClick={() => onCreate("you", "")}
            className={LINK_BUTTON}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add new build…
            <span className="sr-only"> for your plan</span>
          </button>
        </div>
        {item.opponent ? (
          <QueueOpponentLine
            opponent={item.opponent}
            matchup={item.matchup}
            revision={revision}
            actions={actions}
            disabled={writing}
            signal={opponentSignal}
            onAddNew={(query) => onCreate("opponent", query)}
            onNavigate={onNavigate}
          />
        ) : null}
      </div>

      {done ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-2">
          <p
            ref={doneRef}
            id={doneId}
            tabIndex={-1}
            className="flex items-center gap-1.5 rounded text-caption font-semibold text-success focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ClipboardCheck className="h-4 w-4" aria-hidden />
            {outcome}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            aria-describedby={doneId}
            loading={actions.busy === "reopen"}
            disabled={writing}
            iconLeft={<Undo2 className="h-4 w-4" aria-hidden />}
            onClick={() => void undo()}
          >
            Undo
          </Button>
        </div>
      ) : picking ? (
        <div className="mt-3 space-y-3">
          <BuildPicker
            options={builds}
            loading={options.isLoading || (!builds && !options.error)}
            error={options.error ? buildIntentErrorMessage(options.error) : null}
            onRetry={() => void options.mutate()}
            value={selectedKey}
            onChange={(option) => setSelectedKey(option.key)}
            rolledKey={item.randomizer?.key ?? null}
            usualKey={options.data?.usualKey ?? null}
            suggestedKey={suggestion?.key ?? null}
            label={`Build you went for in ${item.matchup ?? "this game"}`}
            onAddNew={(query) => onCreate("you", query)}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- User-opened picker; Cancel restores focus.
            autoFocus
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
            <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {suggestion ? (
            <Button
              ref={confirmRef}
              size="sm"
              className="max-w-full"
              title={`Confirm ${suggestion.name}`}
              loading={actions.busy === "confirm"}
              disabled={busy}
              onClick={() => void confirm(suggestion.key, suggestion.name)}
            >
              Confirm <span className="min-w-0 max-w-[22ch] truncate">{suggestion.name}</span>
            </Button>
          ) : null}
          <Button
            ref={pickRef}
            variant={suggestion ? "secondary" : "primary"}
            size="sm"
            disabled={busy || !item.matchup}
            onClick={() => setPicking(true)}
          >
            {suggestion ? "Change…" : "Pick build…"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={actions.busy === "skip"}
            disabled={busy}
            onClick={() => void skip()}
          >
            No set build
          </Button>
        </div>
      )}

      {batchError && !done ? (
        <p className="mt-2 text-caption text-danger">{batchError}</p>
      ) : null}
      <p
        role={actions.message?.error ? "alert" : "status"}
        aria-live="polite"
        className={actions.message?.error ? "mt-2 text-caption text-danger" : "sr-only"}
      >
        {actions.message?.text ?? ""}
      </p>
    </li>
  );
}

function QueueResultBadge({ result }: { result: string | null }) {
  if (!result) return null;
  const label = resultLabel(result);
  const variant = label === "Win" ? "success" : label === "Loss" ? "danger" : "neutral";
  return (
    <Badge size="sm" variant={variant}>
      {label}
    </Badge>
  );
}

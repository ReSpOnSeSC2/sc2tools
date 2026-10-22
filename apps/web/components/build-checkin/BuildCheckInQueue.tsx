"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { ArrowUpRight, CheckCircle2, ClipboardCheck, Plus, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { useToastOptional } from "@/components/ui/Toast";
import { fmtAgo, fmtMinutes } from "@/lib/format";
import {
  BUILD_CHECKIN_SETTINGS_HREF,
  PENDING_LIMIT_MAX,
  PENDING_WINDOW_HOURS,
  buildIntentErrorMessage,
  dismissPendingIntents,
  effectiveOpponentBuild,
  useBuildOptions,
  usePendingIntents,
  type CheckInSide,
  type GameIntentState,
} from "@/lib/buildIntent";
import { isLossResult, isWinResult } from "@/components/analyzer/game/types";
import { useBuildCheckInRevision } from "./BuildCheckInProvider";
import { BuildPicker } from "./BuildPicker";
import {
  CheckInNewBuild,
  type NewBuildRequest,
  type NewBuildSaved,
} from "./CheckInNewBuild";
import { DetectedLine, ReasonChip } from "./CheckInParts";
import type { PickerSignal } from "./OpponentBuildRow";
import { focusWasLost } from "./focus";
import { CorrectedBadge } from "./PlannedBadge";
import { useCheckInActions } from "./useCheckInActions";
import { useNewBuildCheckIn } from "./useNewBuildCheckIn";

const NO_ITEMS: GameIntentState[] = [];

/**
 * BuildCheckInQueue — the header chip's dialog (a bottom sheet on phones):
 * every game from the last 72 hours still waiting for a check-in, newest
 * first, each with Confirm / Change… / No set build and the opponent's
 * build, plus "Dismiss all". "Add new build…" (your side from the picker,
 * the opponent's from its line) opens one shared build editor; the saved
 * build is checked in for that game straight away.
 */
export function BuildCheckInQueue({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { revision, bump } = useBuildCheckInRevision(open);
  const pending = usePendingIntents(open ? PENDING_LIMIT_MAX : null, revision);
  const data = pending.data;
  const items = Array.isArray(data?.items) ? data.items : NO_ITEMS;
  const total = typeof data?.total === "number" ? data.total : items.length;
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusInBody = useRef(false);

  // One editor for the whole queue: an item can leave the list while its
  // new build is being checked in, which must not take the editor with it.
  const [newBuild, setNewBuild] = useState<{
    request: NewBuildRequest;
    /** The game as listed when the editor opened. */
    item: GameIntentState;
    open: boolean;
    /** The queue session the editor was opened in. */
    session: number;
  } | null>(null);
  const [signal, setSignal] = useState<(PickerSignal & { gameId: string }) | null>(null);
  const writer = useCheckInActions(newBuild?.request.gameId ?? "");
  const checkInNewBuild = useNewBuildCheckIn(writer);
  // Bumped whenever the queue opens or closes: a new build saved or checked
  // in after that belongs to a list the player already left.
  const session = useRef(0);

  // A closed queue unmounts its items: nothing it asked of them may be
  // replayed when it opens again.
  useEffect(() => {
    session.current += 1;
    if (open) return;
    setNewBuild(null);
    setSignal(null);
  }, [open]);

  // A handled game leaves the list on the next refresh; if it took the
  // focused control with it, keep focus inside the dialog.
  useEffect(() => {
    if (!focusInBody.current || !focusWasLost()) return;
    bodyRef.current?.focus({ preventScroll: true });
  }, [items]);

  const openNewBuild = (item: GameIntentState, side: CheckInSide, query = "") =>
    setNewBuild({
      open: true,
      session: session.current,
      item,
      request: {
        gameId: item.gameId,
        side,
        defaultName: query.trim() || undefined,
        myRace: item.myRace,
        oppRace: item.oppRace,
      },
    });

  const closeNewBuild = () => {
    setNewBuild((current) => (current ? { ...current, open: false } : null));
    // The editor hands focus back to the control that opened it; that
    // control is gone when its game was checked in meanwhile.
    window.setTimeout(() => {
      if (focusWasLost()) bodyRef.current?.focus({ preventScroll: true });
    }, 0);
  };

  const onNewBuildSaved = async (saved: NewBuildSaved) => {
    const item = newBuild?.item.gameId === saved.gameId ? newBuild.item : undefined;
    const started = newBuild?.session ?? session.current;
    const outcome = await checkInNewBuild(saved, item);
    if (outcome.state) return;
    // Saved but not checked in: refresh the lists (the new build may now
    // be pickable) and open that game's picker on it. The queue has no
    // opponent picker; the toast says what happened.
    bump();
    if (session.current !== started) return;
    if (saved.side === "you" && item?.eligible !== false && outcome.errorCode !== "not_eligible") {
      setSignal({ gameId: saved.gameId, key: saved.key, open: true, nonce: Date.now() });
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="lg"
        title="Build check-ins"
        description={`Games from the last ${PENDING_WINDOW_HOURS} hours waiting for your plan. A confirmed check-in counts the game toward that build's record.`}
        footer={
          <QueueFooter
            count={total}
            disabled={!data || data.disabled === true}
            onClose={onClose}
            onDismissed={bump}
          />
        }
      >
        {/* Focus lands here when the control that had it leaves the list. */}
        <div
          ref={bodyRef}
          tabIndex={-1}
          className="rounded-lg focus:outline-none"
          onFocus={() => {
            focusInBody.current = true;
          }}
          onBlur={(event) => {
            // No related target: focus went nowhere, e.g. its control was
            // removed. Only a move to another element leaves the list.
            const next = event.relatedTarget;
            if (next instanceof Node && !event.currentTarget.contains(next)) {
              focusInBody.current = false;
            }
          }}
        >
          {!data && pending.error ? (
            <div role="alert" className="space-y-3 py-6 text-center text-caption text-text-muted">
              <p>{buildIntentErrorMessage(pending.error)}</p>
              <Button variant="secondary" size="sm" onClick={() => void pending.mutate()}>
                Try again
              </Button>
            </div>
          ) : !data ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading check-ins">
              {[0, 1, 2].map((row) => (
                <div
                  key={row}
                  className="h-28 rounded-xl border-2 border-line bg-bg-elevated motion-safe:animate-pulse"
                />
              ))}
            </div>
          ) : data.disabled ? (
            <EmptyStatePanel
              size="sm"
              icon={<Settings2 className="h-6 w-6" aria-hidden />}
              title="Build check-ins are off"
              description="Turn them back on in Settings to collect games here. You can still set a planned build from any game page."
            />
          ) : items.length === 0 ? (
            <EmptyStatePanel
              size="sm"
              icon={<CheckCircle2 className="h-6 w-6 text-success" aria-hidden />}
              title="You're all caught up"
              description="New games show up here when the replay lands and nobody has checked them in yet."
            />
          ) : (
            <div className="space-y-3">
              <ul className="space-y-3" aria-label="Games waiting for a check-in">
                {items.map((item) => (
                  <QueueItem
                    key={item.gameId}
                    item={item}
                    revision={revision}
                    signal={signal?.gameId === item.gameId ? signal : null}
                    onSignalHandled={() => setSignal(null)}
                    onOpenGame={onClose}
                    onCreate={(side, query) => openNewBuild(item, side, query)}
                  />
                ))}
              </ul>
              {total > items.length ? (
                <p className="text-center text-micro text-text-dim">
                  Showing the newest {items.length} of {total}.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </Modal>
      <CheckInNewBuild
        request={newBuild?.open ? newBuild.request : null}
        onClose={closeNewBuild}
        onSaved={(saved) => void onNewBuildSaved(saved)}
      />
    </>
  );
}

function QueueFooter({
  count,
  disabled,
  onClose,
  onDismissed,
}: {
  count: number;
  disabled: boolean;
  onClose: () => void;
  onDismissed: () => void;
}) {
  const { getToken } = useAuth();
  const toastContext = useToastOptional();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dismissAll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await dismissPendingIntents(getToken);
      const dismissed = typeof result?.dismissed === "number" ? result.dismissed : count;
      toastContext?.toast.success(
        dismissed === 1 ? "Dismissed 1 check-in" : `Dismissed ${dismissed} check-ins`,
      );
      setConfirming(false);
      onDismissed();
    } catch (err) {
      const message = buildIntentErrorMessage(err);
      setError(message);
      toastContext?.toast.error("Couldn't dismiss check-ins", { description: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Link
        href={BUILD_CHECKIN_SETTINGS_HREF}
        onClick={onClose}
        className="inline-flex min-h-11 items-center gap-1.5 rounded text-caption font-semibold text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Settings2 className="h-4 w-4" aria-hidden />
        Check-in settings
      </Link>
      {confirming ? (
        <div
          role="group"
          aria-label="Confirm dismiss all"
          className="flex flex-wrap items-center justify-end gap-2"
        >
          <span className="text-caption text-text">
            Mark {count === 1 ? "this game" : `all ${count} games`} as no set build?
          </span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} onClick={() => void dismissAll()}>
            Dismiss all
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || count === 0}
          onClick={() => setConfirming(true)}
        >
          Dismiss all
        </Button>
      )}
      {error ? (
        <p role="alert" className="w-full text-right text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function QueueItem({
  item,
  revision,
  signal,
  onSignalHandled,
  onOpenGame,
  onCreate,
}: {
  item: GameIntentState;
  revision: number;
  signal: PickerSignal | null;
  /** The signal is applied once; a remount must not apply it again. */
  onSignalHandled: () => void;
  onOpenGame: () => void;
  onCreate: (side: CheckInSide, query: string) => void;
}) {
  const actions = useCheckInActions(item.gameId);
  const [picking, setPicking] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(item.suggestion?.key ?? null);
  const [done, setDone] = useState(false);
  const options = useBuildOptions(picking ? item.matchup : null, { revision });
  const builds = options.data?.builds;
  const selected = builds?.find((option) => option.key === selectedKey) ?? null;
  const suggestion = item.suggestion;
  const busy = actions.busy !== null || done;
  const titleId = useId();
  const changeRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const returnFocus = useRef(false);
  const opponent = item.opponent
    ? effectiveOpponentBuild(item.opponent, null)
    : null;

  useEffect(() => {
    if (!signal) return;
    setSelectedKey(signal.key);
    setPicking(signal.open);
    onSignalHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per signal
  }, [signal]);

  // Focus never falls out of the dialog when the control that had it
  // unmounts: Cancel returns it to "Change…", a finished check-in moves it
  // to the outcome line.
  useEffect(() => {
    if (picking || !returnFocus.current) return;
    returnFocus.current = false;
    changeRef.current?.focus();
  }, [picking]);
  useEffect(() => {
    if (done) doneRef.current?.focus({ preventScroll: true });
  }, [done]);

  const confirm = async (key: string, name: string) => {
    const outcome = await actions.confirm(key, name);
    if (outcome.state) {
      setDone(true);
      setPicking(false);
    }
  };
  const skip = async () => {
    const outcome = await actions.skip();
    if (outcome.state) {
      setDone(true);
      setPicking(false);
    }
  };
  const cancel = () => {
    returnFocus.current = true;
    setPicking(false);
  };

  return (
    <li
      aria-labelledby={titleId}
      className={[
        "rounded-xl border-2 border-line bg-bg-surface p-3 shadow-hard",
        done ? "opacity-70" : "",
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
        <Link
          href={`/app/game/${encodeURIComponent(item.gameId)}`}
          onClick={onOpenGame}
          className="inline-flex min-h-11 items-center gap-1 rounded px-1 text-caption font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Open game
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>

      <div className="mt-2 space-y-1">
        {suggestion ? (
          <p className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
            Suggested
            <span className="font-semibold text-text">{suggestion.name}</span>
            <ReasonChip suggestion={suggestion} matchup={item.matchup} />
          </p>
        ) : (
          <p className="text-caption text-text-muted">
            No suggestion yet. Pick the build you went for.
          </p>
        )}
        <DetectedLine detected={item.detected?.name} />
        {opponent ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-muted">
            <span>
              Opponent:{" "}
              <span className="font-semibold text-text">{opponent.label?.trim() || "Unknown"}</span>
            </span>
            {opponent.corrected ? <CorrectedBadge detected={opponent.corrected.detected} /> : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => onCreate("opponent", "")}
              className="inline-flex min-h-11 items-center gap-1 rounded px-1 font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add new build…
              <span className="sr-only"> for the opponent</span>
            </button>
          </div>
        ) : null}
      </div>

      {done && actions.message && !actions.message.error ? (
        <p
          ref={doneRef}
          tabIndex={-1}
          className="mt-3 flex items-center gap-1.5 rounded text-caption font-semibold text-success focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ClipboardCheck className="h-4 w-4" aria-hidden />
          {actions.message.text}
        </p>
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
              size="sm"
              loading={actions.busy === "confirm"}
              disabled={busy}
              onClick={() => void confirm(suggestion.key, suggestion.name)}
            >
              Confirm
            </Button>
          ) : null}
          <Button
            ref={changeRef}
            variant={suggestion ? "secondary" : "primary"}
            size="sm"
            disabled={busy || !item.matchup}
            onClick={() => setPicking(true)}
          >
            Change…
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

      <p
        role={actions.message?.error ? "alert" : "status"}
        aria-live="polite"
        className={
          actions.message?.error ? "mt-2 text-caption text-danger" : "sr-only"
        }
      >
        {actions.message?.text ?? ""}
      </p>
    </li>
  );
}

function QueueResultBadge({ result }: { result: string | null }) {
  if (!result) return null;
  const variant = isWinResult(result) ? "success" : isLossResult(result) ? "danger" : "neutral";
  return (
    <Badge size="sm" variant={variant}>
      {result}
    </Badge>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import {
  NEW_BUILD_CHECKED_IN,
  PENDING_LIMIT_MAX,
  PENDING_WINDOW_HOURS,
  buildIntentErrorMessage,
  usePendingIntents,
  type CheckInSide,
  type GameIntentState,
} from "@/lib/buildIntent";
import { useBuildCheckInRevision } from "./BuildCheckInProvider";
import {
  CheckInNewBuild,
  type NewBuildRequest,
  type NewBuildSaved,
} from "./CheckInNewBuild";
import { QueueFooter } from "./QueueFooter";
import { QueueItem, type QueueSignal } from "./QueueItem";
import { focusWasLost } from "./focus";
import { useConfirmAllSuggested, type ConfirmAllResult } from "./useConfirmAllSuggested";
import { useCheckInActions } from "./useCheckInActions";
import { useNewBuildCheckIn } from "./useNewBuildCheckIn";

const NO_ITEMS: GameIntentState[] = [];

/** A game this queue decided (or undid) since it opened. */
interface QueueOutcome {
  /** The game as listed, updated with the write's response. */
  item: GameIntentState;
  /** The outcome line; null once Undo put the game back to waiting. */
  text: string | null;
}

/**
 * The listed game with a write's response folded in; write responses can
 * lack a suggestion the list computed, so the listed one is kept.
 */
function mergeQueueState(listed: GameIntentState, next: GameIntentState): GameIntentState {
  return {
    ...listed,
    ...next,
    suggestion: next.suggestion ?? listed.suggestion,
    opponent: next.opponent === undefined ? listed.opponent : next.opponent,
  };
}

/**
 * The server's pending list plus every game this queue handled since it
 * opened: a handled game leaves the server list, but keeps its outcome and
 * Undo here until the queue closes, in the place it was shown.
 */
function shownItems(
  items: GameIntentState[],
  outcomes: Record<string, QueueOutcome>,
  previousOrder: readonly string[],
): GameIntentState[] {
  const listed = new Set(items.map((item) => item.gameId));
  const rank = (gameId: string) => {
    const at = previousOrder.indexOf(gameId);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const kept = Object.values(outcomes)
    .filter((outcome) => !listed.has(outcome.item.gameId))
    .map((outcome) => outcome.item)
    .sort((a, b) => rank(a.gameId) - rank(b.gameId));
  if (kept.length === 0) return items;
  const shown = [...items];
  for (const entry of kept) {
    const at = previousOrder.indexOf(entry.gameId);
    let insertAt = at < 0 ? shown.length : 0;
    // Right after the nearest game shown above it last time.
    for (let index = at - 1; index >= 0; index -= 1) {
      const neighbour = shown.findIndex((other) => other.gameId === previousOrder[index]);
      if (neighbour >= 0) {
        insertAt = neighbour + 1;
        break;
      }
    }
    shown.splice(insertAt, 0, entry);
  }
  return shown;
}

/**
 * BuildCheckInQueue — the header chip's dialog (a bottom sheet on phones):
 * every game from the last 72 hours still waiting for a check-in, newest
 * first, each with Confirm <suggestion> / Change… (or "Pick build…") / No
 * set build and the opponent's build with its own picker, plus "Confirm
 * all suggested" and "Dismiss all". A decided game keeps its outcome and an
 * Undo until the queue closes. "Add new build…" beside the replay label
 * opens your editor directly; "Add opponent build…" stays on the
 * opponent's line. Both use the shared editor and check the saved build in
 * for that game.
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
  const [outcomes, setOutcomes] = useState<Record<string, QueueOutcome>>({});
  const [batchErrors, setBatchErrors] = useState<Record<string, string>>({});
  const orderRef = useRef<string[]>([]);
  const shown = useMemo(() => shownItems(items, outcomes, orderRef.current), [items, outcomes]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  orderRef.current = shown.map((entry) => entry.gameId);

  const record = useCallback((gameId: string, state: GameIntentState, text: string | null) => {
    const listed = shownRef.current.find((entry) => entry.gameId === gameId);
    setOutcomes((current) => ({
      ...current,
      [gameId]: { item: listed ? mergeQueueState(listed, state) : state, text },
    }));
    setBatchErrors((current) => {
      if (!(gameId in current)) return current;
      const next = { ...current };
      delete next[gameId];
      return next;
    });
  }, []);
  const onBatchResult = useCallback((result: ConfirmAllResult) => {
    if (result.ok) record(result.gameId, result.state, result.text);
    else setBatchErrors((current) => ({ ...current, [result.gameId]: result.text }));
  }, [record]);
  const confirmAll = useConfirmAllSuggested(onBatchResult);
  const stopConfirmAll = confirmAll.stop;
  const targets = shown.flatMap((item) =>
    item.status === "pending" && item.eligible !== false && item.suggestion && !outcomes[item.gameId]?.text
      ? [{ gameId: item.gameId, key: item.suggestion.key, name: item.suggestion.name }]
      : [],
  );

  // Retry only the originally confirmed suggestions that are still
  // pending with the same build key. Fresh arrivals need their own confirmation.
  const retryTargets = confirmAll.progress.remaining.filter((remaining) =>
    targets.some((target) => target.gameId === remaining.gameId && target.key === remaining.key),
  );

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
  const [signal, setSignal] = useState<(QueueSignal & { gameId: string }) | null>(null);
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
    // Closing mid-run lets the write in flight finish, then stops; every
    // outcome and Undo belongs to the list the player just left.
    stopConfirmAll();
    setOutcomes({});
    setBatchErrors({});
  }, [open, stopConfirmAll]);

  // A game handled elsewhere leaves the list on the next refresh; if it
  // took the focused control with it, keep focus inside the dialog.
  useEffect(() => {
    if (!focusInBody.current || !focusWasLost()) return;
    bodyRef.current?.focus({ preventScroll: true });
  }, [shown]);

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
    if (outcome.state) {
      // Your new build decided the game: it keeps its outcome and Undo.
      if (saved.side === "you" && session.current === started) {
        record(saved.gameId, outcome.state, NEW_BUILD_CHECKED_IN);
      }
      return;
    }
    // Saved but not checked in: refresh the lists (the new build may now
    // be pickable) and open that side's picker on it.
    bump();
    if (session.current !== started) return;
    if (item?.eligible !== false && outcome.errorCode !== "not_eligible") {
      setSignal({ gameId: saved.gameId, side: saved.side, key: saved.key, open: true, nonce: Date.now() });
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
            suggestedCount={targets.length}
            retryCount={retryTargets.length}
            progress={confirmAll.progress}
            onClose={onClose}
            onDismissed={bump}
            onConfirmAll={() => void confirmAll.start(targets)}
            onRetry={() => void confirmAll.start(retryTargets)}
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
          ) : shown.length === 0 ? (
            <EmptyStatePanel
              size="sm"
              icon={<CheckCircle2 className="h-6 w-6 text-success" aria-hidden />}
              title="You're all caught up"
              description="New games show up here when the replay lands and nobody has checked them in yet."
            />
          ) : (
            <div className="space-y-3">
              <ul className="space-y-3" aria-label="Games waiting for a check-in">
                {shown.map((item) => (
                  <QueueItem
                    key={item.gameId}
                    item={item}
                    revision={revision}
                    outcome={outcomes[item.gameId]?.text ?? null}
                    batchError={batchErrors[item.gameId] ?? null}
                    batchRunning={confirmAll.progress.phase === "running"}
                    signal={signal?.gameId === item.gameId ? signal : null}
                    onSignalHandled={() => setSignal(null)}
                    onNavigate={onClose}
                    onCreate={(side, query) => openNewBuild(item, side, query)}
                    onDecided={(state, text) => record(item.gameId, state, text)}
                    onReopened={(state) => record(item.gameId, state, null)}
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

"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ANALYSIS_GAMES_CORPUS_MAX,
  type AnalysisGamesResult,
} from "@/components/analyzer/arcade/hooks/useAnalysisGames";
import { deviceNote } from "@/lib/analysisCorpus/deviceNote";
import { defaultIndexedDb } from "@/lib/instant/idb";

const PILL =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-line bg-bg-surface px-3 text-micro font-semibold text-accent transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

/**
 * The line under the Daily Pulse cards: when the history on screen last updated, how many games it holds and whether
 * they are kept on this device, with Refresh. For an account this browser does not keep (after Clear, Delete history
 * or a restore, or for anyone who opened Daily Pulse before it could keep history), it offers to keep it here, and it
 * says when keeping it failed. DailyPulse loads it on demand, so none of it is in the dashboard's first-load JavaScript.
 *
 * Example:
 *   <DailyPulseFooter games={useAnalysisGames()} accountKey={userId} />
 */
export function DailyPulseFooter({ games, accountKey }: { games: AnalysisGamesResult; accountKey: string }) {
  const note = useSyncExternalStore(subscribeToStorage, deviceNote, () => null);
  const now = useMinuteClock();
  const status = useRef<HTMLSpanElement>(null);
  const kept = note === accountKey;
  const canStore = note !== undefined && Boolean(defaultIndexedDb());
  const updating = games.syncedAt === null && !games.error;
  const count = games.items.length;
  const offerKeep = !updating && !games.error && !kept && canStore && !games.hitCorpusLimit;
  const countText = games.hitCorpusLimit
    ? `Latest ${ANALYSIS_GAMES_CORPUS_MAX.toLocaleString()} games`
    : `${count.toLocaleString()} ${count === 1 ? "game" : "games"}${games.onDevice && kept ? " on this device" : ""}`;
  const explanation = games.hitCorpusLimit
    ? `Too many games to keep on this device (over ${ANALYSIS_GAMES_CORPUS_MAX.toLocaleString()}), so they load each visit.`
    : !canStore
      ? "This browser isn’t letting us store data, so your history loads each visit."
      : offerKeep && games.keepFailed
        ? "Couldn’t keep your history in this browser, so it loads each visit."
        : null;
  // Refresh stays focusable while an update runs, and Keep hands focus to the status it changes.
  const refresh = () => {
    if (!updating) games.load();
  };
  const keep = () => {
    games.keepOnDevice();
    status.current?.focus();
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-1 pt-2 text-micro text-text-dim">
      <span>
        <span
          ref={status}
          tabIndex={-1}
          role="status"
          className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {games.error ? "Couldn’t update" : updating ? "Updating…" : "Updated"}
        </span>
        {games.syncedAt !== null && !games.error ? ` ${sinceText(games.syncedAt, now)}` : null}
      </span>
      <span aria-hidden>·</span>
      <span>{countText}</span>
      <button type="button" onClick={refresh} aria-disabled={updating} className={PILL}>
        {games.error ? "Try again" : "Refresh"}
      </button>
      {offerKeep ? (
        <button type="button" onClick={keep} className={PILL}>
          Keep on this device
        </button>
      ) : null}
      {explanation ? <p className="basis-full">{explanation}</p> : null}
    </div>
  );
}

function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** The current time, moved on once a minute so "Updated 5m ago" stays true while the page stays open. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function sinceText(syncedAt: number, now: number): string {
  const minutes = Math.floor((now - syncedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

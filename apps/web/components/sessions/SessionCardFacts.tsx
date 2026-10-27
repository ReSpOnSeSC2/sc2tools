import type { SessionSummary } from "@/lib/sessionHistory";
import { sessionCount, sessionInstant, sessionMinutes, sessionNumber } from "./sessionCardFormat";

export interface SessionCardCurrentView {
  /** Supply only from an admitted definition.mode === "current" wrapper. */
  activity: "active" | "last";
  /** Latest inclusive anchor only; this does not represent a reset history. */
  manualAnchorAt: string | null;
}

export function SessionRecordedRange({ session, timeZone }: { session: SessionSummary; timeZone: string }) {
  return <div className="space-y-1 text-caption text-text-muted">
    <p className="font-semibold text-text">Recorded game ends</p>
    <p className="flex flex-wrap gap-x-2 gap-y-1">
      <time dateTime={session.start}>{sessionInstant(session.start, timeZone)}</time>
      <span>to</span>
      <time dateTime={session.end}>{sessionInstant(session.end, timeZone)}</time>
    </p>
    <p className="break-words">Timezone: {timeZone}</p>
  </div>;
}

export function SessionCardFacts({ session }: { session: SessionSummary }) {
  const wallMinutes = (Date.parse(session.end) - Date.parse(session.start)) / 60_000;
  return <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
    <div><dt className="text-caption text-text-dim">Played time</dt>
      <dd className="text-body font-bold tabular-nums">{sessionMinutes(session.playedMin)}</dd>
      <dd className="text-caption text-text-dim">{session.durationSamples} timed of {sessionCount(session.games, "game")} · {session.durationMissingGames} missing</dd></div>
    <div><dt className="text-caption text-text-dim">Replay-end span</dt>
      <dd className="text-body font-bold tabular-nums">{sessionMinutes(wallMinutes)}</dd>
      <dd className="text-caption text-text-dim">First to last recorded game end</dd></div>
    <div><dt className="text-caption text-text-dim">Average macro</dt>
      <dd className="text-body font-bold tabular-nums">{sessionNumber(session.avgMacro)}{session.avgMacro === null ? "" : " / 100"}</dd>
      <dd className="text-caption text-text-dim">{session.macroSamples} scored of {sessionCount(session.games, "game")} · {session.macroMissingGames} missing</dd></div>
  </dl>;
}

export function SessionScopeNote({ session, timeZone, currentView }: {
  session: SessionSummary; timeZone: string; currentView?: SessionCardCurrentView;
}) {
  return <div className="space-y-1 text-caption text-text-dim">
    {currentView?.manualAnchorAt ? <p>Current view since manual reset: <time dateTime={currentView.manualAnchorAt}>{sessionInstant(currentView.manualAnchorAt, timeZone)}</time>. Natural history may include earlier games.</p> : null}
    {session.coverage.left === "scope" ? <p>Earlier games may fall outside the selected scope.</p> : null}
    {session.coverage.right === "scope" ? <p>Later games may fall outside the selected scope.</p> : null}
    {session.active ? <p>This session is open as of the last refresh.</p> : null}
  </div>;
}

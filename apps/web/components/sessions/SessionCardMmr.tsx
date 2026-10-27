import type { SessionMmrTrack, SessionSummary } from "@/lib/sessionHistory";
import { recordedChange, recordedMmr, sessionCount, sessionRace, type SessionCardSectionHeading } from "./sessionCardFormat";

const MAX_TRACKS = 3;

function RecordedTrack({ track }: { track: SessionMmrTrack }) {
  return <li className="min-w-0 space-y-2 rounded-lg border border-border bg-bg-elevated p-3">
    <p className="break-all text-caption font-semibold"><bdi>{track.myToonHandle}</bdi></p>
    <p className="text-caption text-text-muted">Queue race: {sessionRace(track.ladderRace)}</p>
    <p className="text-caption text-text-muted">Rating scope: {track.ratingScope.replace("-", " · ")}</p>
    {!track.comparable ? <p className="text-caption text-text-dim">Rating track not fully identified. These recorded observations do not establish a comparable ladder change.</p> : null}
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-caption tabular-nums">
      <div><dt className="text-text-dim">First recorded</dt><dd className="font-semibold">{recordedMmr(track.start)}</dd></div>
      <div><dt className="text-text-dim">Last recorded</dt><dd className="font-semibold">{recordedMmr(track.end)}</dd></div>
      <div><dt className="text-text-dim">Recorded change</dt><dd className="font-semibold">{track.comparable && track.ladderRace !== null && track.ratingScope === "ranked-1v1" ? recordedChange(track.delta) : "Unavailable: rating track not fully identified"}</dd></div>
      <div><dt className="text-text-dim">Peak recorded</dt><dd className="font-semibold">{recordedMmr(track.peak)}</dd></div>
    </dl>
    <p className="text-caption text-text-muted">{sessionCount(track.samples, "valid recorded sample")} · {track.missingGames} missing of {sessionCount(track.games, "game")}.</p>
    {track.legacySamples > 0 ? <p className="text-caption text-text-dim">{sessionCount(track.legacySamples, "legacy sample")} {track.legacySamples === 1 ? "has" : "have"} no replay-source label.</p> : null}
  </li>;
}

export function SessionCardMmr({ session, headingTag: Heading }: {
  session: SessionSummary; headingTag: SessionCardSectionHeading;
}) {
  const visible = session.mmr.slice(0, MAX_TRACKS);
  const remaining = session.mmr.length - visible.length;
  return <section aria-label="Recorded MMR" className="min-w-0 space-y-3">
    <Heading className="text-body font-bold">Recorded MMR</Heading>
    <p className="text-caption text-text-dim">Comparable ranked 1v1 changes use the first and last observed values within each exact account and identified queue race.</p>
    {visible.length > 0 ? <ul aria-label="Account and queue-race MMR tracks" className="grid gap-3 lg:grid-cols-3">
      {visible.map(track => <RecordedTrack key={JSON.stringify([track.myToonHandle, track.ladderRace, track.ratingScope])} track={track} />)}
    </ul> : <p className="text-caption text-text-muted">No account-attributed MMR tracks.</p>}
    {remaining > 0 ? <p className="text-caption text-text-dim">Showing {visible.length} of {session.mmr.length} MMR tracks; {remaining} more in session details.</p> : null}
    {session.mmrUnattributedGames > 0 ? <p className="text-caption text-text-dim">{sessionCount(session.mmrUnattributedGames, "game")} could not be assigned to an exact account; {session.mmrUnattributedSamples} {session.mmrUnattributedSamples === 1 ? "contains" : "contain"} recorded MMR.</p> : null}
  </section>;
}

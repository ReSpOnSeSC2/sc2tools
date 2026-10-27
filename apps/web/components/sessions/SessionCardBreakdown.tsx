import type { SessionSummary } from "@/lib/sessionHistory";
import { sessionCount, sessionRecord, sessionSample, type SessionCardSectionHeading } from "./sessionCardFormat";

const MAX_ROWS = 3;
type BreakdownProps = { session: SessionSummary; headingTag: SessionCardSectionHeading };

export function SessionMatchups({ session, headingTag: Heading }: BreakdownProps) {
  const visible = session.matchups.slice(0, MAX_ROWS);
  const remaining = session.matchups.length - visible.length;
  return <section aria-label="Matchups" className="min-w-0 space-y-2">
    <Heading className="text-body font-bold">Matchups</Heading>
    <ul aria-label="Matchup records" className="space-y-2">
      {visible.map(row => <li key={row.matchup} className="text-caption">
        <p className="font-semibold">{row.matchup} · {sessionRecord(row)}</p>
        <p className="text-text-dim">{sessionSample(row)}</p>
      </li>)}
    </ul>
    {remaining > 0 ? <p className="text-caption text-text-dim">{remaining} more matchup records in session details.</p> : null}
  </section>;
}

export function SessionBuilds({ session, headingTag: Heading }: BreakdownProps) {
  const visible = session.topBuilds.slice(0, MAX_ROWS);
  const shownGames = visible.reduce((total, row) => total + row.games, 0);
  const otherGames = session.games - session.buildMissingGames - shownGames;
  return <section aria-label="Top builds" className="min-w-0 space-y-2">
    <Heading className="text-body font-bold">Top builds</Heading>
    <p className="text-caption text-text-dim">Effective build labels and their provenance</p>
    {visible.length > 0 ? <ul aria-label="Build records" className="space-y-3">
      {visible.map(row => <li key={row.name} className="min-w-0 space-y-0.5 text-caption">
        <p className="break-words font-semibold"><bdi>{row.name}</bdi></p>
        <p>{sessionRecord(row)} · {sessionSample(row)}</p>
        <p className="text-text-dim">{row.plannedGames} planned · {row.detectedGames} detected · {row.provenanceUnavailableGames} provenance unavailable</p>
      </li>)}
    </ul> : <p className="text-caption text-text-muted">No named build samples.</p>}
    {otherGames > 0 ? <p className="text-caption text-text-dim">Other named builds: {sessionCount(otherGames, "game")} in session details.</p> : null}
    {session.buildMissingGames > 0 ? <p className="text-caption text-text-dim">Build label missing for {sessionCount(session.buildMissingGames, "game")}.</p> : null}
  </section>;
}

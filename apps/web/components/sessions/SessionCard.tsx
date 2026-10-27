"use client";

import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Card, type CardHeadingLevel } from "@/components/ui/Card";
import type { SessionSummary } from "@/lib/sessionHistory";
import { SessionBuilds, SessionMatchups } from "./SessionCardBreakdown";
import { SessionCardFacts, SessionRecordedRange, SessionScopeNote, type SessionCardCurrentView } from "./SessionCardFacts";
import { SessionCardMmr } from "./SessionCardMmr";
import { SessionResultStrip } from "./SessionResultStrip";
import { sessionCount, sessionDate, sessionInstant, sessionRecord, type SessionCardSectionHeading } from "./sessionCardFormat";

export interface SessionCardProps {
  /** One admitted complete summary; request/empty/error states belong to parent. */
  session: SessionSummary;
  /** Parent-built URL retaining opaque id and admitted scope context. */
  detailHref: string;
  /** Admitted output timezone, never the browser's implicit timezone. */
  timeZone: string;
  headingLevel?: CardHeadingLevel;
  /** Omit for natural history; supply only for the admitted current wrapper. */
  currentView?: SessionCardCurrentView;
}

export function SessionCard({ session, detailHref, timeZone, headingLevel = 2, currentView }: SessionCardProps) {
  const Heading = `h${headingLevel}` as const;
  const sectionHeading = `h${headingLevel + 1}` as SessionCardSectionHeading;
  const title = currentView ? currentView.activity === "active" ? "This session" : "Last session" : "Session";
  const label = `${title} · ${sessionDate(session.start, timeZone)}`;
  const range = `${sessionInstant(session.start, timeZone)} to ${sessionInstant(session.end, timeZone)}`;
  return <Card padded={false} aria-label={label} className="min-w-0">
    <Card.Header className="flex-wrap items-start">
      <Heading className="min-w-0 text-h4 font-display font-bold">{label}</Heading>
      {session.active ? <Badge variant="success">Open at refresh</Badge> : null}
    </Card.Header>
    <Card.Body className="min-w-0 space-y-5">
      <SessionRecordedRange session={session} timeZone={timeZone} />
      <p className="text-body font-bold tabular-nums">{sessionCount(session.games, "game")} · {sessionRecord(session)}</p>
      <SessionResultStrip results={session.results} />
      <SessionCardFacts session={session} />
      <SessionScopeNote session={session} timeZone={timeZone} currentView={currentView} />
      <SessionCardMmr session={session} headingTag={sectionHeading} />
      <div className="grid min-w-0 gap-5 md:grid-cols-2">
        <SessionMatchups session={session} headingTag={sectionHeading} />
        <SessionBuilds session={session} headingTag={sectionHeading} />
      </div>
    </Card.Body>
    <Card.Footer>
      <LinkButton href={detailHref} variant="secondary" size="md" className="w-full sm:w-auto" aria-label={`View session details: ${range}`}>View session details</LinkButton>
    </Card.Footer>
  </Card>;
}

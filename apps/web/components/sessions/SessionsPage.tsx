"use client";

import { useMemo } from "react";
import { useFilters } from "@/lib/filterContext";
import { clientTimezone } from "@/lib/timeseries";
import { useUrlQueryWriter } from "@/lib/useUrlQueryWriter";
import { PageHeader } from "@/components/ui/PageHeader";
import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import type { SessionHistoryList } from "@/lib/sessionHistory";
import { changeSessionQuery, sessionDetailHref, sessionHref, sessionListApi, sessionListQuery, refreshSessionQuery, sessionScopeIsSynced, sessionTransportError } from "@/lib/sessionHistoryUrls";
import { SessionCard } from "./SessionCard";
import { SessionRequestState } from "./SessionRequestState";
import { SessionViewControls } from "./SessionViewControls";
import { useSessionRequest } from "./useSessionRequest";

export function SessionsPage() {
  const { filters, dbRev } = useFilters();
  const writer = useUrlQueryWriter();
  const tz = useMemo(() => clientTimezone(), []);
  const query = sessionListQuery(filters, new URLSearchParams(writer.search), tz);
  const problem = sessionTransportError(query);
  const q = useSessionRequest<SessionHistoryList>(problem || !sessionScopeIsSynced(filters, new URLSearchParams(writer.search)) ? null : `${sessionListApi(query)}#${dbRev}`);
  const restart = refreshSessionQuery(query), guard = writer.capture();
  const restartSameRequest = sessionListApi(sessionListQuery(filters, restart, tz)) === sessionListApi(query);
  const navigate = (next: URLSearchParams) => { if (q.current()) writer.update(() => next, "push", guard); };
  return <div className="space-y-5">
    <PageHeader as="h2" size="section" title="Session history" description="Review complete sessions inside your selected filters. The output day or window selects sessions; it does not split their membership at midnight." />
    <SessionViewControls query={query} navigate={navigate} refresh={() => restartSameRequest ? q.mutate() : navigate(restart)} />
    {problem ? <Card><p role="alert">{problem}</p></Card> : <SessionRequestState q={q} restartHref={sessionHref(restart)} restartSameRequest={restartSameRequest}
      contextHref={days => sessionHref(changeSessionQuery(query, { contextDays: String(days) }))}
      isEmpty={() => false} emptyTitle="No sessions in this output window">{data => <>
        <SessionWindowNote data={data} />
        {data.items.length === 0 ? <Card><EmptyStatePanel title="No sessions in this output window" description="Your membership filters remain applied. Browse the previous output window for older sessions." /></Card> : null}
        <div className="space-y-5">{data.items.slice(0, 50).map(session => <SessionCard key={session.id} session={session} headingLevel={3}
          timeZone={data.window.tz} detailHref={sessionDetailHref(session.id, query, data.window)} />)}</div>
        <SessionListNavigation data={data} query={query} />
      </>}</SessionRequestState>}
  </div>;
}

function SessionWindowNote({ data }: { data: SessionHistoryList }) {
  return <p className="text-caption text-text-muted">Output window: <time dateTime={data.window.from}>{data.window.from}</time> to <time dateTime={data.window.to}>{data.window.to}</time> (end exclusive), timezone {data.window.tz}. Sessions split after more than {data.definition.gapMinutes} minutes. Refresh advances the read view.</p>;
}

function SessionListNavigation({ data, query }: { data: SessionHistoryList; query: URLSearchParams }) {
  const next = new URLSearchParams(query);
  if (data.nextBefore) { next.set("before", data.nextBefore); if (!next.has("day")) { if (!next.has("windowFrom")) next.set("sessionRolling", "1"); next.set("windowFrom", data.window.from); next.set("windowTo", data.window.to); } }
  const older = data.nextWindow ? changeSessionQuery(query, { day: null, windowFrom: data.nextWindow.from, windowTo: data.nextWindow.to, sessionRolling: null }) : null;
  return <nav aria-label="Session history pages" className="flex flex-wrap gap-3">
    {data.nextBefore ? <LinkButton href={sessionHref(next)} scroll={false} variant="secondary">Older sessions in this window</LinkButton> : <p className="text-caption text-text-muted">This output window is exhausted.</p>}
    {older ? <LinkButton href={sessionHref(older)} scroll={false} variant="secondary">Previous output window</LinkButton> : null}
  </nav>;
}

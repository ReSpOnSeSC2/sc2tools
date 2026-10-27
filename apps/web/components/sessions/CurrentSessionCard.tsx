"use client";

import { useMemo } from "react";
import { useFilters } from "@/lib/filterContext";
import { clientTimezone } from "@/lib/timeseries";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";
import type { SessionHistoryCurrent } from "@/lib/sessionHistory";
import { sessionCurrentApi, sessionDetailHref, sessionHistoryHref } from "@/lib/sessionHistoryUrls";
import { SessionRequestState } from "./SessionRequestState";
import { SessionResultStrip } from "./SessionResultStrip";
import { sessionCount, sessionInstant, sessionRecord } from "./sessionCardFormat";
import { useSessionRequest } from "./useSessionRequest";

export function CurrentSessionCard() {
  const { filters, dbRev } = useFilters();
  const tz = useMemo(() => clientTimezone(), []);
  const query = new URLSearchParams({ tz, sessionView: "current" });
  const q = useSessionRequest<SessionHistoryCurrent>(`${sessionCurrentApi(query)}#${dbRev}`);
  return <div data-testid="kpi-today-session" className="col-span-2 min-w-0 lg:col-span-1">
    <SessionRequestState q={q} restartHref="/app" restartSameRequest isEmpty={() => false} emptyTitle="No session in the current view">{data =>
      <CurrentSessionReady data={data} query={query} historyHref={sessionHistoryHref(filters, { tz })} />
    }</SessionRequestState>
  </div>;
}

function CurrentSessionReady({ data, query, historyHref }: { data: SessionHistoryCurrent; query: URLSearchParams; historyHref: string }) {
  const session = data.session;
  const title = data.activity === "active" ? "This session" : data.activity === "last" ? "Last session" : "Current session view";
  return <Card className="h-full" title={title}>
    {session ? <><p className="text-h3 font-bold tabular-nums">{sessionCount(session.games, "game")}</p>
      <p className="mb-3 text-caption">{sessionRecord(session)}</p><SessionResultStrip results={session.results} />
      <p className="mt-3 text-caption text-text-muted">Latest recorded end: <time dateTime={session.end}>{sessionInstant(session.end, data.window.tz)}</time>.</p></>
      : <EmptyStatePanel size="sm" title="No session in the current view" description="There are no recorded games in the live scope after its latest manual reset." />}
    <p className="mt-2 text-caption text-text-muted">As of <time dateTime={data.window.asOf}>{sessionInstant(data.window.asOf, data.window.tz)}</time>.</p>
    <p className="mt-2 text-caption text-text-dim">Live 14-day view, stats-visible games, excluding resumed and future games. Uses the latest manual reset and ignores global analysis filters.</p>
    {data.manualAnchorAt ? <p className="mt-2 text-caption text-text-dim">Since manual reset: <time dateTime={data.manualAnchorAt}>{sessionInstant(data.manualAnchorAt, data.window.tz)}</time>.</p> : null}
    <div className="mt-3 flex flex-wrap gap-2">{session ? <LinkButton href={sessionDetailHref(session.id, query)} variant="secondary">View this session</LinkButton> : null}
      <LinkButton href={historyHref} variant="ghost">Natural session history</LinkButton></div>
  </Card>;
}

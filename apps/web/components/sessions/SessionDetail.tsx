"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import { useFilters } from "@/lib/filterContext";
import { useUrlQueryWriter } from "@/lib/useUrlQueryWriter";
import { clientTimezone } from "@/lib/timeseries";
import { Card } from "@/components/ui/Card";
import { Button, LinkButton } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import type { QueryLike } from "@/components/ui/QueryState";
import type { SessionHistoryDetail } from "@/lib/sessionHistory";
import { changeSessionQuery, sessionDetailApi, sessionDetailHref, sessionDetailQuery, sessionHref, refreshSessionQuery, sessionScopeIsSynced, sessionTransportError } from "@/lib/sessionHistoryUrls";
import { SessionCard } from "./SessionCard";
import { SessionRequestState } from "./SessionRequestState";
import { SessionGamesPage } from "./SessionGamesPage";
import { useSessionRequest } from "./useSessionRequest";

const SessionMmrChart = dynamic(() => import("./SessionMmrChart").then(mod => mod.SessionMmrChart), {
  loading: () => <p role="status">Loading recorded MMR chart…</p>, ssr: false,
});

export function SessionDetail({ id }: { id: string }) {
  const { filters, dbRev } = useFilters();
  const writer = useUrlQueryWriter(), tz = useMemo(() => clientTimezone(), []);
  const query = sessionDetailQuery(filters, new URLSearchParams(writer.search), tz);
  const problem = sessionTransportError(query);
  const q = useSessionRequest<SessionHistoryDetail>(problem || query.get("sessionView") !== "current" && !sessionScopeIsSynced(filters, new URLSearchParams(writer.search)) ? null : `${sessionDetailApi(id, query)}#${dbRev}`);
  const current = query.get("sessionView") === "current";
  const restart = refreshSessionQuery(query); restart.delete("sessionView");
  const back = new URLSearchParams(query); back.delete("gamesBefore"); back.delete("gamesLimit"); back.delete("sessionView");
  const backHref = current ? "/app" : sessionHref(back);
  const freshHref = current ? "/app" : sessionHref(restart);
  const reportQuery = new URLSearchParams(query); reportQuery.delete("gamesBefore"); reportQuery.delete("gamesLimit");
  const reportKey = JSON.stringify([q.owner, id, current, sessionDetailApi(id, reportQuery), dbRev]);
  return <SessionReportBody key={reportKey} q={q} requestKey={q.key} query={query} id={id} problem={problem} current={current} backHref={backHref} freshHref={freshHref} />;
}

type ReportBodyProps = {
  q: QueryLike<SessionHistoryDetail>; requestKey: string; query: URLSearchParams; id: string;
  problem: string | null; current: boolean; backHref: string; freshHref: string;
};

/** Only UI intent survives same-report game paging; no response or cursor is retained. */
function SessionReportBody({ q, requestKey, query, id, problem, current, backHref, freshHref }: ReportBodyProps) {
  const [chart, setChart] = useState(false);
  const gamesFocus = useRef(false);
  const requestGamesFocus = useCallback(() => { gamesFocus.current = true; }, []);
  const consumeGamesFocus = useCallback(() => {
    const pending = gamesFocus.current; gamesFocus.current = false; return pending;
  }, []);
  return <div className="space-y-5">
    <PageHeader as="h2" size="section" title="Session report" description={current ? "Current view: the latest live 14 days, after the latest inclusive manual reset. Global analysis filters do not apply." : "A complete session within the membership filters saved in this link."}
      actions={<><LinkButton href={backHref} scroll={false} variant="ghost">{current ? "Back to Today" : "Back to session history"}</LinkButton><Button variant="secondary" onClick={() => q.mutate()}>Refresh report</Button></>} />
    {problem ? <Card><p role="alert">{problem}</p></Card> : <SessionRequestState q={q} restartHref={freshHref}
      contextHref={current ? undefined : days => sessionDetailHref(id, changeSessionQuery(query, { contextDays: String(days) }))}
      isEmpty={data => data.session === null} emptyTitle="No complete session in this view">{data => <SessionDetailReady key={requestKey} data={data} query={query} id={id} chart={chart} loadChart={() => setChart(true)} requestGamesFocus={requestGamesFocus} consumeGamesFocus={consumeGamesFocus} />}</SessionRequestState>}
  </div>;
}

type DetailReadyProps = {
  data: SessionHistoryDetail; query: URLSearchParams; id: string; chart: boolean; loadChart: () => void;
  requestGamesFocus: () => void; consumeGamesFocus: () => boolean;
};

function SessionDetailReady({ data, query, id, chart, loadChart, requestGamesFocus, consumeGamesFocus }: DetailReadyProps) {
  const session = data.session;
  if (!session) return null;
  return <div className="space-y-5">
    <SessionCard session={session} headingLevel={3} timeZone={data.window.tz} detailHref={sessionDetailHref(id, query)}
      currentView={data.definition.mode === "current" ? { activity: session.active ? "active" : "last", manualAnchorAt: null } : undefined} />
    <Card title="Recorded MMR over this session" headingLevel={3}>
      {chart ? <SessionMmrChart tracks={data.mmr} timeZone={data.window.tz} /> : <Button variant="secondary" onClick={loadChart}>Load recorded MMR chart</Button>}
    </Card>
    <SessionGamesPage data={data} query={query} id={id} onNextGames={requestGamesFocus} consumeFocusIntent={consumeGamesFocus} />
    <Card title="Observed results after a loss" headingLevel={3}><p className="text-body">{session.afterLoss.wins} wins · {session.afterLoss.losses} losses across {session.afterLoss.decidedGames} observed next-decided results after a loss.</p>
      <p className="mt-2 text-caption text-text-muted">Unknown outcomes stay neutral. {session.afterLoss.lossWithoutFollowingDecision ? "The last decided loss has no following decided result in this session." : "Every decided loss with a follow-up contributes one observed result."} These counts describe this session and do not establish tilt or a reason to continue playing.</p></Card>
  </div>;
}

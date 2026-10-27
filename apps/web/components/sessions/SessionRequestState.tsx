"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Card, Skeleton } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { QueryState, type QueryLike } from "@/components/ui/QueryState";
import type { SessionHistoryBase } from "@/lib/sessionHistory";

export function SessionRequestState<T extends SessionHistoryBase>({ q, restartHref, restartSameRequest = false, contextHref, isEmpty, emptyTitle, children }: {
  q: QueryLike<T>; restartHref: string; restartSameRequest?: boolean; contextHref?: (days: number) => string;
  isEmpty: (data: T) => boolean; emptyTitle: string; children: (data: T) => ReactNode;
}) {
  const admitted = { ...q, data: q.error ? undefined : q.data };
  const panel = useRef<HTMLDivElement>(null), previousHeight = useRef(0);
  useLayoutEffect(() => {
    if (!panel.current || !admitted.data) return;
    const measure = () => { previousHeight.current = panel.current?.getBoundingClientRect().height ?? 0; };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(panel.current);
    return () => observer.disconnect();
  }, [admitted.data]);
  const loading = !admitted.data && !q.error;
  return <div ref={panel} style={loading && previousHeight.current > 0 ? { minHeight: previousHeight.current } : undefined}><QueryState q={admitted} skeleton={<Card><p role="status">Loading session view…</p><Skeleton rows={4} /></Card>}
    errorTitle="Sessions" filtered renderError={error => {
      if (!error || typeof error !== "object" || !("status" in error) || error.status !== 409) return undefined;
      return <Card><div role="alert" className="space-y-3"><p className="font-semibold">This session view changed</p>
        <p className="text-caption text-text-muted">Games or the session definition changed. Open a fresh view to continue.</p>
        <SessionRestartAction href={restartHref} retry={q.mutate} sameRequest={restartSameRequest}>Open fresh session view</SessionRestartAction></div></Card>;
    }}>{data => {
      if (data.status !== "ready") return <SessionBoundState data={data} contextHref={contextHref} restartHref={restartHref} retry={q.mutate} restartSameRequest={restartSameRequest} />;
      return isEmpty(data) ? <Card><EmptyStatePanel title={emptyTitle} description="This is a complete empty result for the displayed scope and output window." /></Card> : children(data);
    }}</QueryState></div>;
}

function SessionBoundState({ data, contextHref, restartHref, retry, restartSameRequest }: {
  data: SessionHistoryBase; contextHref?: (days: number) => string; restartHref: string; retry: () => unknown; restartSameRequest: boolean;
}) {
  const context = data.status === "context_required";
  const days = data.issue?.suggestedContextDays;
  return <Card><div role="status" className="space-y-3">
    <p className="font-semibold">{context ? "More session context is needed" : "This session view is too large"}</p>
    <p className="text-caption text-text-muted">{data.issue?.message ?? "The bounded request could not produce complete sessions."}</p>
    {!context ? <p className="text-caption text-text-muted">Choose a smaller output window. An individual session can still exceed the supported size.</p> : null}
    {context && contextHref && days !== null && days !== undefined ? <LinkButton href={contextHref(days)} scroll={false} variant="secondary">Check with more context</LinkButton> : null}
    <SessionRestartAction href={restartHref} retry={retry} sameRequest={restartSameRequest}>Restart this view</SessionRestartAction>
  </div></Card>;
}

function SessionRestartAction({ href, retry, sameRequest, children }: { href: string; retry: () => unknown; sameRequest: boolean; children: ReactNode }) {
  return <LinkButton href={href} scroll={false} variant="secondary" onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const target = new URL(href, window.location.href), current = new URL(window.location.href);
    target.searchParams.sort(); current.searchParams.sort();
    if (!sameRequest && (target.pathname !== current.pathname || target.search !== current.search)) return;
    event.preventDefault(); void retry();
  }}>{children}</LinkButton>;
}

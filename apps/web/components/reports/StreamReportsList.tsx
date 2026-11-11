"use client";

import { formatDateTime } from "@/lib/i18n/format";
import { useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/clientApi";
import { plural, record, signed, type StreamSummary } from "@/lib/reports";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";

type StreamPage = { items: StreamSummary[]; nextBefore: string | null };

/** /app/streams: every stream report, newest first (the newest 100 are kept). */
export function StreamReportsList() {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors.at(-1);
  const query = useApi<StreamPage>(`/v1/reports/streams?limit=20${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
  const page = query.data;
  return <div className="space-y-5">
    <PageHeader title="Stream reports" description="A report for every stream you end in the Dock, or that goes four hours without a game." actions={<LazyHelpLink slug="stream-reports" />} />
    {query.error && !page ? <RequestError error={query.error} onRetry={() => query.mutate()} /> : !page ? <Skeleton rows={4} /> : page.items.length === 0 && cursors.length === 1
      ? <Card><EmptyStatePanel title="No stream reports yet" description="Press Start new session in the Stream Dock when you go live and End stream when you finish. The report appears here and in your notifications." /></Card>
      : <>
        <ul className="space-y-3">{page.items.map((row) => <li key={row.id}><Card>
          <Link href={`/app/streams/${row.id}`} className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <p className="text-body font-semibold text-text">{formatDateTime(new Date(row.startAt), { dateStyle: "medium", timeStyle: "short" })}</p>
            <p className="text-caption text-text-muted">{plural(row.games, "game")} · {record(row)} · {row.hours} h{row.mmrDelta !== null ? ` · ${signed(row.mmrDelta)} MMR` : ""}</p>
          </Link>
        </Card></li>)}</ul>
        <nav aria-label="Stream report pages" className="flex flex-wrap gap-2">
          {cursors.length > 1 ? <Button variant="secondary" size="sm" className="min-h-11" onClick={() => setCursors((list) => list.slice(0, -1))}>Newer reports</Button> : null}
          {page.nextBefore ? <Button variant="secondary" size="sm" className="min-h-11" onClick={() => setCursors((list) => [...list, page.nextBefore])}>Older reports</Button> : null}
        </nav>
      </>}
  </div>;
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/clientApi";
import { clock, practiceGamesPath, type PracticeGameRow, type PracticeGamesPage } from "@/lib/practiceLog";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { QueryState } from "@/components/ui/QueryState";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { GRADE_TEXT_CLASS } from "./gradeStyles";

/** The target's graded games, newest first, a page at a time. */
export function PracticeGamesList({ matchup, targetHash }: { matchup: string; targetHash: string }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  return (
    <Card title="Graded games">
      <div className="space-y-3">
        {cursors.map((cursor, index) => (
          <GamesPage key={cursor ?? "first"} path={practiceGamesPath(matchup, targetHash, cursor)}
            last={index === cursors.length - 1} onMore={(next) => setCursors((list) => [...list, next])} />
        ))}
      </div>
    </Card>
  );
}

function GamesPage({ path, last, onMore }: { path: string; last: boolean; onMore: (cursor: string) => void }) {
  const page = useApi<PracticeGamesPage>(path, { revalidateOnFocus: false });
  return (
    <QueryState q={page} skeleton={<SkeletonRows rows={3} label="Loading graded games" />}
      isEmpty={(data) => data.items.length === 0} empty={last ? <p className="text-caption text-text-muted">No graded games yet.</p> : null}>
      {(data) => (
        <>
          <ul className="divide-y divide-border">
            {data.items.map((row) => <GameRow key={row.gameId} row={row} />)}
          </ul>
          {last && data.nextCursor ? <Button variant="ghost" size="sm" onClick={() => onMore(data.nextCursor!)}>Show more</Button> : null}
        </>
      )}
    </QueryState>
  );
}

function GameRow({ row }: { row: PracticeGameRow }) {
  const p = row.practice;
  const when = row.date ? new Date(row.date).toLocaleDateString() : "Unknown date";
  return (
    <li className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-4">
      <span className={`w-8 shrink-0 font-display text-h3 font-bold ${p.grade ? GRADE_TEXT_CLASS[p.grade] : "text-text-dim"}`}>
        <span aria-hidden>{p.grade ?? "–"}</span><span className="sr-only">{p.grade ? `Grade ${p.grade}` : "Not graded"}</span>
      </span>
      <div className="min-w-0 flex-1 text-caption">
        <p className="text-text">
          {when}{row.map ? ` · ${row.map}` : ""}{row.result ? ` · ${row.result}` : ""}
          {p.via === "request" ? <span className="text-text-dim"> · graded on request</span> : null}
        </p>
        <p className="text-text-muted">
          {p.status === "no_build_log"
            ? "Not graded: this upload had no build log."
            : `${p.matched}/${p.total} steps · ${p.avgDrift}s average drift · ${p.firstDivergence ? `fell off at ${p.firstDivergence.name} (planned ${clock(p.firstDivergence.expectedT)}, ${p.firstDivergence.actualT === null ? "skipped" : `built ${clock(p.firstDivergence.actualT)}`})` : "no divergence"}`}
        </p>
      </div>
      <Link href={`/app/game/${encodeURIComponent(row.gameId)}#builds`} className="min-h-11 shrink-0 content-center text-caption text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        Open game
      </Link>
    </li>
  );
}

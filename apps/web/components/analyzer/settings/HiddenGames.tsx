"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { QueryState } from "@/components/ui/QueryState";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { REPLAY_HIDE_REASONS, type ReplayControlTarget } from "@/lib/replayGameControls";
import { GameControlActions } from "../replays/GameControlActions";
import { SettingsSectionsReady } from "./SettingsSectionNav";

type HiddenGame = ReplayControlTarget & { opponent: string; reason: string | null };
type HiddenPage = { items: HiddenGame[]; nextCursor: string | null };

export default function HiddenGames() {
  const { userId, isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <Skeleton rows={3} />;
  if (!isSignedIn || !userId) return null;
  return <HiddenGamesList key={userId} />;
}

function HiddenGamesList() {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1];
  const q = useApi<HiddenPage>(`/v1/games/hidden${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { keepPreviousData: false });
  const refresh = useRef<HTMLButtonElement>(null), active = useRef(true), scope = useRef(cursor);
  scope.current = cursor;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  // The keyed owner boundary unmounts old actions and drops their pending state.
  // Keep explicit focus restoration away from a row that a mutation removes.
  const completed = async () => {
    const captured = cursor;
    await q.mutate();
    if (active.current && scope.current === captured) refresh.current?.focus();
  };
  return <Section id="hidden-games" className="scroll-mt-28" title="Hidden games" description="Your hidden replays stay available for playback. Unhide restores their contribution to your statistics and scouting.">
    <SettingsSectionsReady />
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <LazyHelpLink slug="hide-or-delete-a-game">Hiding, deletion and retry help</LazyHelpLink>
        <Button ref={refresh} variant="secondary" loading={q.isValidating} onClick={() => void q.mutate()}>Refresh hidden games</Button>
      </div>
      <QueryState q={q} skeleton={<Skeleton rows={3} />} isEmpty={data => data.items.length === 0} empty={<p className="text-body text-text-muted">No hidden games or pending deletions on this page.</p>}>
        {data => <ul className="divide-y divide-border">{data.items.map(game => <li key={game.gameId} className="space-y-3 py-4 first:pt-0">
          <div className="min-w-0 space-y-1">
            <p className="break-words font-semibold">{game.pendingDeletion ? "Pending deletion" : game.map || "Replay"}{game.opponent ? ` · ${game.opponent}` : ""}</p>
            <p className="break-all font-mono text-micro text-text-muted">{game.gameId}</p>
            <p className="text-caption text-text-muted">{game.pendingDeletion ? "Cloud cleanup is incomplete. Retry deletion to finish; this game cannot be unhidden." : REPLAY_HIDE_REASONS.find(reason => reason.value === game.reason)?.label || "Hidden from stats"}{game.date ? ` · ${new Date(game.date).toLocaleDateString()}` : ""}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!game.pendingDeletion ? <Link className="inline-flex min-h-11 items-center rounded-lg px-3 text-caption font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={`/app/game/${encodeURIComponent(game.gameId)}`}>View game</Link> : null}
            <GameControlActions targets={[{ ...game, excluded: true }]} scopeKey={`hidden:${cursor || "first"}:${game.gameId}`} onComplete={completed} />
          </div>
        </li>)}</ul>}
      </QueryState>
      <nav aria-label="Hidden games pages" className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={cursors.length === 1 || q.isLoading} onClick={() => setCursors(previous => previous.slice(0, -1))}>Previous page</Button>
        <span className="text-caption text-text-muted">Page {cursors.length}</span>
        <Button variant="secondary" disabled={!q.data?.nextCursor || q.isLoading || q.isPreviousData} onClick={() => { const next = q.data?.nextCursor; if (next) setCursors(previous => [...previous, next]); }}>Next page</Button>
      </nav>
    </Card>
  </Section>;
}

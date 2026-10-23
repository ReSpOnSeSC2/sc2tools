"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { RequestError } from "@/components/ui/RequestError";
import { useApi } from "@/lib/clientApi";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { fmtDate, fmtMinutes } from "@/lib/format";
import { isReviewableGame, matchupFromRaces, reviewsRollout, reviewsVisible } from "@/lib/reviews";
import type { ReplayLibraryItem, ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import { AskForReviewDialog } from "./AskForReviewButton";

export function AskAboutGameButton() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const me = useApi<{ isAdmin: boolean }>(reviewsRollout() === "admins" ? "/v1/me" : null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReplayLibraryItem | null>(null);
  useEffect(() => { setOpen(false); setSelected(null); }, [userId]);
  if (!isLoaded || !isSignedIn || !reviewsVisible(me.data?.isAdmin)) return null;
  return <>
    <Button onClick={() => setOpen(true)}>Ask about one of your games</Button>
    {open ? <AskGamePicker onClose={() => setOpen(false)} onChoose={(game) => { setOpen(false); setSelected(game); }} /> : null}
    {selected ? <AskForReviewDialog key={`${userId}:${selected.gameId}`} gameId={selected.gameId} durationSec={selected.durationSec} matchup={selected.matchup || matchupFromRaces(selected.myRace, selected.opponent?.race)} onClose={() => setSelected(null)} /> : null}
  </>;
}

export function AskGamePicker({ onClose, onChoose }: { onClose: () => void; onChoose: (game: ReplayLibraryItem) => void }) {
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 250);
  const [navigation, setNavigation] = useState<{ scope: string; cursor: string | null }>({ scope: query, cursor: null });
  const [previous, setPrevious] = useState<{ scope: string; items: ReplayLibraryItem[] }>({ scope: query, items: [] });
  const cursor = navigation.scope === query ? navigation.cursor : null;
  const params = new URLSearchParams({ limit: "20", sort: "date_desc" });
  if (query) params.set("search", query);
  if (cursor) params.set("cursor", cursor);
  const request = useApi<ReplayLibraryResponse>(`/v1/replays?${params.toString()}`, { keepPreviousData: false, revalidateOnFocus: false });
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setNavigation({ scope: query, cursor: null }); setPrevious({ scope: query, items: [] }); }, [query]);
  const all = [...new Map([...(previous.scope === query ? previous.items : []), ...(request.data?.items ?? [])].map((game) => [game.gameId, game])).values()];
  const games = all.filter(isReviewableGame);
  return <Modal open onClose={onClose} title="Pick a game to ask about" description="Choose one of your synced 1v1 games. Your question opens next." size="lg" initialFocusRef={searchRef}>
    <div className="space-y-4">
      <Field label="Search your games" htmlFor={searchId}><Input ref={searchRef} id={searchId} type="search" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={200} autoComplete="off" placeholder="Map, opponent or build…" /></Field>
      {request.error ? <RequestError title="Couldn't load your games" error={request.error} onRetry={() => request.mutate()} /> : null}
      {!request.data && !request.error ? <div aria-busy="true" aria-label="Loading your games" className="space-y-2">{[0, 1, 2].map((item) => <div key={item} className="h-20 animate-pulse rounded-lg bg-bg-elevated" />)}</div> : null}
      {games.length ? <ul aria-label="Games available for review" className="space-y-2">{games.map((game) => {
        const matchup = game.matchup || matchupFromRaces(game.myRace, game.opponent?.race);
        const result = game.result || "Unknown";
        const resultKind = result.toLowerCase();
        return <li key={game.gameId}><button type="button" onClick={() => onChoose(game)} className="flex min-h-16 w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg-surface p-3 text-left hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><span className="min-w-0 space-y-1"><span className="flex flex-wrap items-center gap-2">{matchup ? <Badge size="sm" variant="accent">{matchup}</Badge> : null}<span className="break-words text-caption font-semibold text-text">{game.map || "Unknown map"}</span><Badge size="sm" variant={["win", "victory"].includes(resultKind) ? "success" : ["loss", "defeat"].includes(resultKind) ? "danger" : "neutral"}>{result}</Badge></span><span className="block text-micro text-text-muted">{game.date ? fmtDate(game.date) : "Unknown date"} · {game.durationSec ? fmtMinutes(game.durationSec) : "Unknown length"}</span></span><span className="text-caption font-semibold text-link">Choose game</span></button></li>;
      })}</ul> : request.data && !request.error ? <EmptyStatePanel title={!query && all.length === 0 ? "No synced games yet" : query ? `No 1v1 games match ‘${query}’` : "No 1v1 games on this page"} description="Reviews use 1v1 games synced from the desktop app." action={<div className="flex flex-wrap justify-center gap-3"><Link href="/download" className="inline-flex min-h-11 items-center font-semibold text-link underline">Get the desktop app</Link><Link href="/devices" className="inline-flex min-h-11 items-center font-semibold text-link underline">Pair a device</Link></div>} /> : null}
      {request.data?.page.nextCursor ? <Button variant="secondary" disabled={request.isLoading || request.isValidating} onClick={() => { setPrevious({ scope: query, items: all }); setNavigation({ scope: query, cursor: request.data!.page.nextCursor }); }}>Load more</Button> : null}
    </div>
  </Modal>;
}

"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Link2,
  LockKeyhole,
  RefreshCcw,
  Search,
  Share2,
  ShieldCheck,
  Tv2,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { defaultAnalyzerFilters, filtersToQuery, useFilters } from "@/lib/filterContext";
import { ReplayList } from "./ReplayList";
import { ReplayCsvExportButton } from "./ReplayCsvExportButton";
import { GameControlActions } from "./GameControlActions";
import { GameSourceLabelProvider } from "../GameAnalysisLink";
import type { ReplayLibraryResponse, ReplaySharingResponse } from "./types";
import { useReplayListFilters } from "@/lib/useReplayListFilters";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { rememberReplayPage, rememberReplayRow, replayPageMemory, replayRowMemoryKey, replayScrollBehavior, replayUntil } from "@/lib/replayListNavigation";

const PAGE_SIZE = 25;

type SortFilter = "date_desc" | "date_asc";

/** Signed-in replay archive mounted at /app/replays. */
export function ReplayLibrary() {
  const { userId, isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <Skeleton rows={3} />;
  if (!isSignedIn || !userId) return null;
  return <ReplayLibraryBody key={userId} ownerId={userId} />;
}

function ReplayLibraryBody({ ownerId }: { ownerId: string }) {
  const { filters, setFilters, dbRev, seasons } = useFilters();
  const local = useReplayListFilters();
  const { search, setSearch, result, setResult, matchup, setMatchup, sort, setSort, before, setBefore, committed, reset: resetReplayFilters } = local;
  const globalQuery = filtersToQuery(filters);
  const priorGlobal = useRef(globalQuery), blockedCursor = useRef<string | null>(null);
  if (priorGlobal.current !== globalQuery) { priorGlobal.current = globalQuery; blockedCursor.current = committed.cursor; }
  if (!committed.cursor) blockedCursor.current = null;
  const cursor = committed.cursor && blockedCursor.current === committed.cursor ? null : committed.cursor;
  const clearCursor = useRef(local.clearCursor); clearCursor.current = local.clearCursor;
  useEffect(() => { if (blockedCursor.current) clearCursor.current(); }, [globalQuery]);
  const [selecting, setSelecting] = useState(false), [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const selectionButton = useRef<HTMLButtonElement>(null);
  const filterKey = JSON.stringify({ globalQuery, search: committed.search.trim(), result: committed.result, matchup: committed.matchup, sort: committed.sort, before: committed.before });
  const [memoryReady, setMemoryReady] = useState(false);
  useEffect(() => setMemoryReady(true), []);
  const memory = useMemo(() => memoryReady ? replayPageMemory(ownerId, filterKey, cursor) : { previous: null, hasPrevious: false, page: cursor ? null : 1 }, [memoryReady, ownerId, filterKey, cursor]);
  const queryFor = (values: { search: string; result: string; matchup: string; sort: string; before: string }, pageCursor?: string | null) => {
    const params = new URLSearchParams(globalQuery.slice(1));
    params.set("sort", values.sort);
    if (values.search.trim()) params.set("search", values.search.trim());
    if (values.result !== "all") params.set("result", values.result);
    if (values.matchup !== "all") params.set("matchup", values.matchup);
    const until = replayUntil(params.get("until"), values.before); if (until) params.set("until", until);
    if (pageCursor) params.set("cursor", pageCursor);
    return params;
  };
  const params = queryFor(committed, cursor); params.set("limit", String(PAGE_SIZE));
  const path = `/v1/replays?${params}`;
  // Export follows the visible controls, independently of cursor/debounced list.
  const exportQuery = queryFor({ search, result, matchup, sort, before }).toString();
  const selectionScope = `${exportQuery}:${cursor || ""}`;
  const priorSelectionScope = useRef(selectionScope);
  useEffect(() => { if (priorSelectionScope.current !== selectionScope) { priorSelectionScope.current = selectionScope; setSelectedIds(new Set()); } }, [selectionScope]);
  const { data, error, isLoading, isValidating, isPreviousData, mutate } = useApi<ReplayLibraryResponse>(path, { keepPreviousData: true, revalidateOnFocus: false });
  const seenRev = useRef(dbRev);
  useEffect(() => { if (seenRev.current !== dbRev) { seenRev.current = dbRev; void mutate(); } }, [dbRev, mutate]);
  const currentScope = useRef({ filterKey, cursor }); currentScope.current = { filterKey, cursor };
  useEffect(() => {
    if (!data || isPreviousData) return;
    let target: { key?: string; cursor?: string | null; gameId?: string; href?: string };
    try { const raw = sessionStorage.getItem(replayRowMemoryKey(ownerId)); if (!raw || raw.length > 16384) return; target = JSON.parse(raw); } catch { return; }
    if (target.key !== filterKey || target.cursor !== cursor || typeof target.gameId !== "string" || target.href !== `${location.pathname}${location.search}${location.hash}`) return;
    const id = window.requestAnimationFrame(() => {
      if (currentScope.current.filterKey !== filterKey || currentScope.current.cursor !== cursor) return;
      const matches = [...document.querySelectorAll<HTMLElement>("[data-replay-game-id]")].filter(node => node.dataset.replayGameId === target.gameId);
      const row = matches.find(node => node.getClientRects().length > 0) || matches[0];
      if (row) { row.scrollIntoView({ behavior: replayScrollBehavior(), block: "center" }); try { sessionStorage.removeItem(replayRowMemoryKey(ownerId)); } catch { /* Optional scroll memory. */ } }
    });
    return () => window.cancelAnimationFrame?.(id);
  }, [data, isPreviousData, ownerId, filterKey, cursor]);
  const playerName = data?.profile.displayName?.trim() || "You";
  const selectionStale = local.pendingFilters || Boolean(isPreviousData) || search.trim() !== committed.search.trim() || priorSelectionScope.current !== selectionScope;
  const currentSelection = selectionStale ? new Set<string>() : selectedIds;
  const selectedTargets = (data?.items || []).filter(game => currentSelection.has(game.gameId));
  const hasReplayFilters = search.length > 0 || result !== "all" || matchup !== "all" || sort !== "date_desc" || !!before;
  const defaults = defaultAnalyzerFilters(seasons), hasGlobalFilters = filtersToQuery(defaults) !== globalQuery;
  function goOlder() {
    const next = data?.page.nextCursor; if (!next || isPreviousData || local.pendingFilters) return;
    rememberReplayPage(ownerId, filterKey, cursor, next); local.setCursor(next); scrollToList();
  }
  function goNewer() { if (local.pendingFilters) return; local.setCursor(memory.hasPrevious ? memory.previous : null); scrollToList(); }
  const clearActions = <div className="flex flex-wrap justify-center gap-2"><Button variant="secondary" onClick={resetReplayFilters}>Clear replay filters</Button>{hasGlobalFilters ? <Button variant="ghost" onClick={() => { resetReplayFilters(); setFilters(defaults); }}>Reset all filters</Button> : null}</div>;
  return <div className="space-y-4">
    <Card padded={false} className="scroll-mt-24" id="replay-library-list">
      <div className="border-b-2 border-line p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-display text-h3 font-bold text-text">Replays</h2>{data ? <Badge variant="cyan" size="sm">{data.items.length}{data.total != null ? ` of ${data.total.toLocaleString()}` : ""} shown</Badge> : null}{(isValidating || local.pendingFilters) && data ? <span className="inline-flex items-center gap-1 text-micro text-text-dim" role="status"><RefreshCcw className="h-3 w-3 animate-spin" aria-hidden /> Refreshing</span> : null}</div><p className="mt-1 text-caption text-text-muted">Search synced games within the global filters above.</p><span className="sr-only" role="status" aria-live="polite">{data ? `${data.items.length} replays shown${memory.page ? ` on page ${memory.page}` : " on the saved page"}.` : ""}</span></div><div className="flex flex-wrap items-start gap-2"><ReplayCsvExportButton query={exportQuery} /><ReplayShareControl /></div></div>
        <ReplayLibraryTip />
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="relative min-w-48 flex-1"><span className="sr-only">Search replays</span><Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-text-dim" aria-hidden /><Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Player, map, build or strategy" className="pl-9" maxLength={100} /></label>
          <div role="group" aria-label="Filter by result" className="flex flex-wrap gap-1">{([['all','All'],['win','Wins'],['loss','Losses']] as const).map(([value,label]) => <Button key={value} variant="secondary" size="sm" className="min-h-11" aria-pressed={result === value} onClick={() => setResult(value)}>{label}</Button>)}</div>
          <label className="text-micro text-text-muted">Matchup<Select value={matchup} onChange={event => setMatchup(event.target.value)} aria-label="Filter by matchup"><option value="all">All matchups</option>{MATCHUPS.map(value => <option key={value} value={value}>{value}</option>)}</Select></label>
          <label className="text-micro text-text-muted">Sort<Select value={sort} onChange={event => setSort(event.target.value as SortFilter)} aria-label="Sort replays"><option value="date_desc">Newest first</option><option value="date_asc">Oldest first</option></Select></label>
          <label className="text-micro text-text-muted">Jump to date<Input type="date" aria-label="Jump to date" value={before} onChange={event => setBefore(event.target.value)} className="min-h-11" /></label>
          <Button variant="ghost" size="sm" onClick={resetReplayFilters} disabled={!hasReplayFilters}>Reset</Button><Button variant="secondary" size="sm" aria-pressed={selecting} onClick={() => { setSelecting(value => !value); setSelectedIds(new Set()); }}>Select replays</Button>
        </div>
        {before || result === "tie" ? <div className="mt-2 flex flex-wrap gap-2">{before ? <Button size="sm" variant="ghost" aria-label="Clear replay date" onClick={() => setBefore("")}>Before {new Date(`${before}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} ×</Button> : null}{result === "tie" ? <Button size="sm" variant="ghost" onClick={() => setResult("all")}>Ties only ×</Button> : null}</div> : null}
        {selecting ? <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3"><Button ref={selectionButton} variant="secondary" disabled={selectionStale || !data?.items.length} onClick={() => setSelectedIds(currentSelection.size === data?.items.length ? new Set() : new Set(data?.items.map(game => game.gameId) || []))}>{currentSelection.size === data?.items.length && currentSelection.size ? "Clear selection" : "Select this page"}</Button><span className="text-caption text-text-muted">{currentSelection.size} selected · this page only (up to {PAGE_SIZE})</span><GameControlActions targets={selectedTargets} scopeKey={`library:${selectionScope}`} onComplete={async changes => { setSelectedIds(previous => new Set([...previous].filter(id => !changes.some(change => change.gameId === id)))); await mutate(); if (priorSelectionScope.current === selectionScope) selectionButton.current?.focus(); }} /></div> : null}
      </div>
      <div inert={!!isPreviousData || local.pendingFilters} aria-busy={!!isPreviousData || local.pendingFilters} className={isPreviousData || local.pendingFilters ? "opacity-60" : undefined}>
        {isLoading && !data ? <div className="p-4" aria-busy="true" aria-label="Loading replay history"><Skeleton rows={6} /></div> : error ? <ReplayError error={error} onRetry={() => void mutate()} /> : data ? <GameSourceLabelProvider label="Replay Library" filters={path.split("?", 2)[1]} replace><ReplayList items={data.items} owner playerName={playerName} listQuery={path.split("?", 2)[1]} emptyAction={clearActions} onOpenReplay={gameId => rememberReplayRow(ownerId, filterKey, cursor, gameId)} selection={selecting ? { selectedIds: currentSelection, disabled: selectionStale, onToggle: gameId => { if (selectionStale) return; setSelectedIds(previous => { const next = new Set(previous); if (next.has(gameId)) next.delete(gameId); else next.add(gameId); return next; }); } } : undefined} /></GameSourceLabelProvider> : null}
      </div>
      {cursor || data?.page.hasMore ? <nav className="flex items-center justify-between gap-3 border-t-2 border-line px-4 py-3" aria-label="Replay pages"><Button variant="secondary" size="sm" onClick={goNewer} disabled={!cursor || !!isPreviousData || local.pendingFilters} iconLeft={<ChevronLeft className="h-4 w-4" aria-hidden />}>{cursor && !memory.hasPrevious ? "Back to newest" : "Newer"}</Button><span className="text-micro text-text-dim">{memory.page ? `Page ${memory.page}` : "Saved page"}</span><Button variant="secondary" size="sm" onClick={goOlder} disabled={!data?.page.hasMore || !data.page.nextCursor || !!isPreviousData || local.pendingFilters} iconRight={<ChevronRight className="h-4 w-4" aria-hidden />}>Older</Button></nav> : null}
    </Card>
  </div>;
}
function ReplayLibraryTip() {
  const [dismissed, dismiss] = useLocalStorageState("replays.introDismissed", false, (raw): raw is boolean => typeof raw === "boolean");
  return dismissed ? null : <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-border bg-bg-elevated/30 p-3"><p className="text-caption text-text-muted">Personal match tape: every replay, ready for review.</p><Button variant="ghost" size="sm" aria-label="Dismiss replay tip" onClick={() => dismiss(true)}>Dismiss</Button></div>;
}

function ReplayShareControl() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const sharingReq = useApi<ReplaySharingResponse>("/v1/me/replay-sharing", { revalidateOnFocus: false });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyResetTimer = useRef<number | null>(null);
  const sharing = sharingReq.data;
  const handle = sharing?.enabled ? sharing.handle : null;
  const path = handle ? `/players/${encodeURIComponent(handle)}/replays` : null;

  useEffect(() => () => {
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
  }, []);

  async function setEnabled(enabled: boolean): Promise<ReplaySharingResponse | null> {
    if (saving) return null;
    setSaving(true);
    try {
      const next = await apiCall<ReplaySharingResponse>(getToken, "/v1/me/replay-sharing", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      await sharingReq.mutate(next, { revalidate: false });
      toast.success(enabled ? "Public replay page is live" : "Public replay page turned off");
      return next;
    } catch (error) {
      toast.error("Couldn't update replay sharing", { description: (error as ClientApiError)?.message || "Please try again." });
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function copyLink(targetHandle = handle) {
    if (!targetHandle || copying) return;
    const targetPath = `/players/${encodeURIComponent(targetHandle)}/replays`;
    const href = `${window.location.origin}${targetPath}`;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
      copyResetTimer.current = window.setTimeout(() => {
        copyResetTimer.current = null;
        setCopied(false);
      }, 1800);
      toast.success("Replay page link copied");
    } catch {
      window.prompt("Copy this replay page link", href);
    } finally {
      setCopying(false);
    }
  }

  async function enableAndCopy() {
    const next = sharing?.enabled && sharing.handle
      ? sharing
      : await setEnabled(true);
    if (next?.handle) await copyLink(next.handle);
  }

  return (
    <>
      <div
        className="flex w-full shrink-0 flex-col gap-2 sm:w-auto"
        role="group"
        aria-label="Replay sharing actions"
      >
        <Button
          variant={sharing?.enabled && handle ? "secondary" : "primary"}
          onClick={() => setOpen(true)}
          disabled={saving}
          iconLeft={sharing?.enabled && handle ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Share2 className="h-4 w-4" aria-hidden />}
          className="w-full"
        >
          {sharing?.enabled && handle ? "Sharing on" : "Share"}
        </Button>
        {sharing?.enabled && handle ? (
          <Button
            variant="ghost"
            onClick={() => void copyLink()}
            loading={copying}
            disabled={saving}
            iconLeft={copied ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            className="w-full"
            aria-label="Copy public replay page link"
          >
            <span aria-live="polite">{copied ? "Copied" : "Copy link"}</span>
          </Button>
        ) : null}
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Share your replay archive"
        description="A private-by-default player page for teammates, coaches and viewers."
        size="md"
        footer={
          sharingReq.isLoading ? (
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
          ) : sharingReq.error ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
              <Button variant="secondary" size="sm" onClick={() => void sharingReq.mutate()} iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}>Try again</Button>
            </>
          ) : sharing?.enabled && handle ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => void setEnabled(false)} loading={saving}>Turn off sharing</Button>
              <Button size="sm" onClick={() => void copyLink()} loading={copying} iconLeft={copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}>
                {copied ? "Copied" : "Copy link"}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void enableAndCopy()} loading={saving} iconLeft={<Link2 className="h-4 w-4" aria-hidden />}>
              Turn on and copy link
            </Button>
          )
        }
      >
        {sharingReq.isLoading ? (
          <div aria-busy="true"><Skeleton rows={3} /></div>
        ) : sharingReq.error ? (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-caption text-danger">Sharing settings could not be loaded. Try the request again or close this dialog.</p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border-2 border-line bg-bg-elevated/45 p-4">
              <div className="flex items-start gap-3">
                {sharing?.enabled && handle ? <Tv2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden /> : <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" aria-hidden />}
                <div className="min-w-0">
                  <p className="font-semibold text-text">{sharing?.enabled && handle ? "Your player replay page is public" : "Your replay archive is private"}</p>
                  <p className="mt-1 break-all font-mono text-micro text-text-muted">{path || "Your personal player replay address is created when you turn sharing on."}</p>
                  {path ? (
                    <Link href={path} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-md text-caption font-semibold text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                      Preview public page <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="flex items-center gap-2 text-caption font-semibold text-text"><ShieldCheck className="h-4 w-4 text-accent-cyan" aria-hidden /> Exactly what visitors can see</h3>
              <p className="text-caption leading-relaxed text-text-muted">
                Turning this on shares every synced replay in this archive—not only games visible under your current dashboard filters. Anyone can see replay dates, maps, results, player display names and races, game-time MMR, detected builds and strategies, macro scores, matched Twitch or YouTube VOD links, and download archived original replay files. Replay Analysis and the full Macro breakdown require the visitor to sign in to SC2 Tools.
              </p>
              <p className="text-caption leading-relaxed text-text-muted">
                An original .SC2Replay can contain player/account identifiers, chat, team information, and other data Blizzard embeds in the file. Starting a download also gives that visitor a temporary storage URL, which can reveal the storage host and object path until it expires in about one minute.
              </p>
              <p className="text-caption leading-relaxed text-text-muted">
                Turn sharing off at any time to disable the page, analysis access and new downloads. Your player replay address stays assigned to you and becomes available again if you re-enable sharing. A download URL already issued before sharing is disabled can continue working until its one-minute expiry.
              </p>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function ReplayError({ error, onRetry }: { error: ClientApiError; onRetry: () => void }) {
  return (
    <div className="p-5" role="alert">
      <div className="flex flex-col items-start justify-between gap-3 rounded-xl border border-danger/40 bg-danger/8 p-4 sm:flex-row sm:items-center">
        <div>
          <p className="font-semibold text-text">Couldn't load replay history</p>
          <p className="mt-1 text-caption text-text-muted">{error.message}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onRetry} iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}>Try again</Button>
      </div>
    </div>
  );
}

function scrollToList() {
  window.requestAnimationFrame(() => {
    document.getElementById("replay-library-list")?.scrollIntoView({ behavior: replayScrollBehavior(), block: "start" });
  });
}

const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ", "RvP", "RvT", "RvZ"] as const;

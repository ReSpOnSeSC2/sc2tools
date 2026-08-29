"use client";

import {
  useDeferredValue,
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
  ListVideo,
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
import { filtersToQuery, useFilters } from "@/lib/filterContext";
import { ReplayList } from "./ReplayList";
import type { ReplayLibraryResponse, ReplaySharingResponse } from "./types";

const PAGE_SIZE = 25;

type ResultFilter = "all" | "win" | "loss" | "tie";
type SortFilter = "date_desc" | "date_asc";

/** Signed-in replay archive mounted at /app/replays. */
export function ReplayLibrary() {
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [result, setResult] = useState<ResultFilter>("all");
  const [matchup, setMatchup] = useState("all");
  const [sort, setSort] = useState<SortFilter>("date_desc");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);

  const filterKey = useMemo(
    () => JSON.stringify({ filters, deferredSearch, result, matchup, sort }),
    [filters, deferredSearch, result, matchup, sort],
  );
  const previousFilterKey = useRef(filterKey);

  useEffect(() => {
    if (previousFilterKey.current === filterKey) return;
    previousFilterKey.current = filterKey;
    setCursor(null);
    setCursorHistory([]);
  }, [filterKey]);

  const path = useMemo(() => {
    const params = new URLSearchParams(filtersToQuery(filters).slice(1));
    params.set("limit", String(PAGE_SIZE));
    params.set("sort", sort);
    if (deferredSearch) params.set("search", deferredSearch);
    if (result !== "all") params.set("result", result);
    if (matchup !== "all") params.set("matchup", matchup);
    if (cursor) params.set("cursor", cursor);
    return `/v1/replays?${params.toString()}`;
  }, [filters, sort, deferredSearch, result, matchup, cursor]);

  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate,
  } = useApi<ReplayLibraryResponse>(path, {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });
  const seenRev = useRef(dbRev);
  useEffect(() => {
    if (seenRev.current === dbRev) return;
    seenRev.current = dbRev;
    void mutate();
  }, [dbRev, mutate]);

  const playerName = data?.profile.displayName?.trim() || "You";
  const hasReplayFilters = search.length > 0 || result !== "all" || matchup !== "all" || sort !== "date_desc";

  function resetReplayFilters() {
    setSearch("");
    setResult("all");
    setMatchup("all");
    setSort("date_desc");
  }

  function goOlder() {
    const next = data?.page.nextCursor;
    if (!next) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(next);
    scrollToList();
  }

  function goNewer() {
    if (cursorHistory.length === 0) return;
    const history = [...cursorHistory];
    const previous = history.pop() ?? null;
    setCursorHistory(history);
    setCursor(previous);
    scrollToList();
  }

  return (
    <div className="space-y-5">
      <ReplayLibraryIntro />

      <Card padded={false} className="scroll-mt-24" id="replay-library-list">
        <div className="border-b-2 border-line p-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-h3 font-bold text-text">Replay archive</h2>
                {data ? (
                  <Badge variant="cyan" size="sm">
                    {data.items.length}{data.total != null ? ` of ${data.total.toLocaleString()}` : ""} shown
                  </Badge>
                ) : null}
              {isValidating && data ? (
                <span className="inline-flex items-center gap-1 text-micro text-text-dim" role="status">
                  <RefreshCcw className="h-3 w-3 animate-spin" aria-hidden /> Refreshing
                </span>
              ) : null}
              <span className="sr-only" role="status" aria-live="polite">
                {data ? `${data.items.length} replays shown on page ${cursorHistory.length + 1}.` : ""}
              </span>
              </div>
              <p className="mt-1 max-w-2xl text-caption text-text-muted">
                Search every synced game. The date, region, map pool, format and length controls above also apply here.
              </p>
            </div>

            <div className="grid w-full gap-2 sm:grid-cols-2 xl:w-auto xl:grid-cols-[minmax(240px,1fr)_130px_135px_145px_auto]">
              <label className="relative sm:col-span-2 xl:col-span-1">
                <span className="sr-only">Search replays</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-text-dim" aria-hidden />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Player, map, build or strategy"
                  className="pl-9"
                  maxLength={100}
                />
              </label>
              <label>
                <span className="sr-only">Result</span>
                <Select value={result} onChange={(event) => setResult(event.target.value as ResultFilter)} aria-label="Filter by result">
                  <option value="all">All results</option>
                  <option value="win">Wins</option>
                  <option value="loss">Losses</option>
                  <option value="tie">Ties</option>
                </Select>
              </label>
              <label>
                <span className="sr-only">Matchup</span>
                <Select value={matchup} onChange={(event) => setMatchup(event.target.value)} aria-label="Filter by matchup">
                  <option value="all">All matchups</option>
                  {MATCHUPS.map((value) => <option key={value} value={value}>{value}</option>)}
                </Select>
              </label>
              <label>
                <span className="sr-only">Sort replays</span>
                <Select value={sort} onChange={(event) => setSort(event.target.value as SortFilter)} aria-label="Sort replays">
                  <option value="date_desc">Newest first</option>
                  <option value="date_asc">Oldest first</option>
                </Select>
              </label>
              <Button variant="ghost" size="sm" onClick={resetReplayFilters} disabled={!hasReplayFilters}>
                Reset
              </Button>
            </div>
          </div>
        </div>

        <div>
          {isLoading && !data ? (
            <div className="p-4" aria-busy="true" aria-label="Loading replay history"><Skeleton rows={6} /></div>
          ) : error ? (
            <ReplayError error={error} onRetry={() => void mutate()} />
          ) : data ? (
            <ReplayList items={data.items} owner playerName={playerName} />
          ) : null}
        </div>

        {data && (cursorHistory.length > 0 || data.page.hasMore) ? (
          <nav className="flex items-center justify-between gap-3 border-t-2 border-line px-4 py-3" aria-label="Replay pages">
            <Button
              variant="secondary"
              size="sm"
              onClick={goNewer}
              disabled={cursorHistory.length === 0}
              iconLeft={<ChevronLeft className="h-4 w-4" aria-hidden />}
            >
              Newer
            </Button>
            <span className="text-micro text-text-dim">Page {cursorHistory.length + 1}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={goOlder}
              disabled={!data.page.hasMore || !data.page.nextCursor}
              iconRight={<ChevronRight className="h-4 w-4" aria-hidden />}
            >
              Older
            </Button>
          </nav>
        ) : null}
      </Card>
    </div>
  );
}

function ReplayLibraryIntro() {
  return (
    <Card variant="feature" padded={false} className="relative overflow-hidden">
      <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-accent-cyan/10 blur-3xl" aria-hidden />
      <div className="relative flex flex-col gap-5 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border-2 border-line bg-bg-elevated text-accent-cyan shadow-hard">
            <ListVideo className="h-6 w-6" aria-hidden />
          </div>
          <div>
            <p className="overline text-accent-cyan">Personal match tape</p>
            <h2 className="mt-1 font-display text-h2 font-bold text-text">Every replay, ready for review</h2>
            <p className="mt-1 max-w-2xl text-body text-text-muted">
              Jump from a clean game log into the full replay analysis, macro breakdown, original replay file, or a timestamped stream POV.
            </p>
          </div>
        </div>
        <ReplayShareControl />
      </div>
    </Card>
  );
}

function ReplayShareControl() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const sharingReq = useApi<ReplaySharingResponse>("/v1/me/replay-sharing", { revalidateOnFocus: false });
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const sharing = sharingReq.data;
  const handle = sharing?.enabled ? sharing.handle : null;
  const path = handle ? `/p/${encodeURIComponent(handle)}/replays` : null;

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
    if (!targetHandle) return;
    const targetPath = `/p/${encodeURIComponent(targetHandle)}/replays`;
    const href = `${window.location.origin}${targetPath}`;
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      toast.success("Replay page link copied");
    } catch {
      window.prompt("Copy this replay page link", href);
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
      <Button
        variant={sharing?.enabled && handle ? "secondary" : "primary"}
        onClick={() => setOpen(true)}
        iconLeft={sharing?.enabled && handle ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Share2 className="h-4 w-4" aria-hidden />}
        className="shrink-0"
      >
        {sharing?.enabled && handle ? "Sharing on" : "Share replay page"}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Share your replay archive"
        description="A private-by-default link for teammates, coaches and viewers."
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
              <Button size="sm" onClick={() => void copyLink()} iconLeft={copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}>
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
                  <p className="font-semibold text-text">{sharing?.enabled && handle ? "Your page is public to anyone with the link" : "Your replay archive is private"}</p>
                  <p className="mt-1 break-all font-mono text-micro text-text-muted">{path || "A new opaque link is created when you turn sharing on."}</p>
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
                Turning this on shares every synced replay in this archive—not only games visible under your current dashboard filters. Visitors can see replay dates, maps, results, player display names and races, game-time MMR, detected builds and strategies, macro metrics, matched Twitch or YouTube VOD links, public analysis and macro breakdowns, and downloads for archived original replay files.
              </p>
              <p className="text-caption leading-relaxed text-text-muted">
                An original .SC2Replay can contain player/account identifiers, chat, team information, and other data Blizzard embeds in the file. Starting a download also gives that visitor a temporary storage URL, which can reveal the storage host and object path until it expires in about one minute.
              </p>
              <p className="text-caption leading-relaxed text-text-muted">
                Turn sharing off at any time to disable the page and new downloads. That share-page URL is revoked; re-enabling creates a different opaque link. A download URL already issued before revocation can continue working until its one-minute expiry.
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
    document.getElementById("replay-library-list")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ", "RvP", "RvT", "RvZ"] as const;

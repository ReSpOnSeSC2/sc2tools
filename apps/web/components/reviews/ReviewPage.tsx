"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { ArrowLeft, Lock, MessageSquarePlus, MoreHorizontal, Pin, PinOff } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Toggle } from "@/components/ui/Toggle";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { MapArtwork } from "@/components/maps/MapArtwork";
import { apiCall } from "@/lib/clientApi";
import { usePublicApi } from "@/lib/usePublicApi";
import type { ReplayMapMarker } from "@/components/analyzer/game/MapReplayer";
import type { CommentTimelineMarker } from "@/components/analyzer/game/replay/TransportDock";
import {
  commentClusters,
  formatClock,
  levelLabel,
  pinNumbers,
  REVIEW_LIMITS,
  reviewHeadline,
  reviewsRollout,
  tagLabel,
  type ReviewAnalysis,
  type ReviewPageData,
} from "@/lib/reviews";
import { ReviewComposer, type DraftPin } from "./ReviewComposer";
import { ReviewReplayDownload } from "./ReviewReplayDownload";
import { ReviewReplayPanel } from "./ReviewReplayPanel";
import { ReviewShareMenu } from "./ReviewShareMenu";
import { REPORT_REASONS, ReviewMenu } from "./ReviewMenu";
import { ReviewThread } from "./ReviewThread";

/**
 * /reviews/[id] — one review request: the replay on the left (pinned at
 * the top on phones, with comments scrolling beneath), the question and
 * the timestamped / map-pinned thread on the right.
 *
 * Server-rendered data arrives as ``initial`` (crawlers and signed-out
 * visitors get the full thread in the HTML); the client refetches with
 * the viewer's token for personal state (votes, capabilities).
 */
export function ReviewPage({ initial }: { initial: ReviewPageData }) {
  const id = initial.request.id;
  const enc = encodeURIComponent(id);
  const { isSignedIn } = useAuth();
  const pageReq = usePublicApi<ReviewPageData>(`/v1/reviews/${enc}`, {
    fallbackData: initial,
    // The server render is anonymous and briefly cached; refetch once so
    // a signed-in viewer sees their own votes and capabilities.
    revalidateOnMount: true,
    revalidateOnFocus: true,
  }, { personalized: true });
  const data = pageReq.data ?? initial;
  const analysisReq = usePublicApi<ReviewAnalysis>(
    data.request.hidden ? null : `/v1/reviews/${enc}/analysis`,
    { revalidateOnFocus: false, shouldRetryOnError: false },
    // The admins-only stage 404s anonymous reads, so send the token then.
    { personalized: reviewsRollout() === "admins" },
  );

  const [currentTime, setCurrentTime] = useState(0);
  const [seekRequest, setSeekRequest] = useState<{ t: number; seq: number } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const [draftPins, setDraftPins] = useState<Record<string, DraftPin>>({});
  const clearPin = useCallback((owner: string) => {
    setDraftPins((old) => { const next = { ...old }; delete next[owner]; return next; });
    setPickingFor((old) => old === owner ? null : old);
  }, []);
  const togglePin = useCallback((owner: string) => setPickingFor((old) => old === owner ? null : owner), []);
  const [composing, setComposing] = useState<number | null>(null);
  const [playbackAvailable, setPlaybackAvailable] = useState(false);
  const [pinned, setPinned] = useState(true);
  const seq = useRef(0);

  const duration = data.request.game.durationSec;
  const pins = useMemo(() => pinNumbers(data.comments), [data.comments]);

  const seek = useCallback((t: number, commentId?: string) => {
    seq.current += 1;
    setSeekRequest({ t, seq: seq.current });
    setCurrentTime(t);
    if (commentId) setActiveId(commentId);
  }, []);

  const mapMarkers = useMemo<ReplayMapMarker[]>(() => {
    const out: ReplayMapMarker[] = [];
    for (const c of data.comments) {
      const n = pins.get(c.id);
      if (!n || !c.mapPoint || c.gameTimeSec === null) continue;
      out.push({ id: c.id, x: c.mapPoint.x, y: c.mapPoint.y, t: c.gameTimeSec, endT: c.endTimeSec, label: String(n), active: c.id === activeId });
    }
    for (const [owner, pin] of Object.entries(draftPins)) {
      out.push({ id: `__draft__:${owner}`, x: pin.x, y: pin.y, t: pin.t, label: "+", draft: true });
    }
    return out;
  }, [data.comments, pins, activeId, draftPins]);

  const commentMarkers = useMemo<CommentTimelineMarker[]>(
    () => commentClusters(data.comments, duration ?? 0).map((cluster) => {
      const first = data.comments.find((c) => c.id === cluster.ids[0]);
      const t = first?.gameTimeSec ?? cluster.startSec;
      return {
        id: `cluster-${cluster.startSec}`,
        t,
        count: cluster.count,
        label: cluster.count === 1 ? `Comment at ${formatClock(t)}` : `${cluster.count} comments near ${formatClock(t)}`,
      };
    }),
    [data.comments, duration],
  );

  const scrollToComment = useCallback((commentId: string) => {
    setActiveId(commentId);
    document.getElementById(`comment-${commentId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const onCommentMarker = useCallback((marker: CommentTimelineMarker) => {
    const cluster = commentClusters(data.comments, duration ?? 0).find((c) => `cluster-${c.startSec}` === marker.id);
    seek(marker.t, cluster?.ids[0]);
    if (cluster?.ids[0]) scrollToComment(cluster.ids[0]);
  }, [data.comments, duration, seek, scrollToComment]);

  const onWorldClick = useCallback((x: number, y: number, t: number) => {
    if (!pickingFor) return;
    setDraftPins((old) => ({ ...old, [pickingFor]: { x, y, t } }));
    setPickingFor(null);
  }, [pickingFor]);

  const onMarkerClick = useCallback((markerId: string) => {
    if (markerId.startsWith("__draft__:")) return;
    const c = data.comments.find((x) => x.id === markerId);
    if (c?.gameTimeSec !== null && c?.gameTimeSec !== undefined) seek(c.gameTimeSec, c.id);
    scrollToComment(markerId);
  }, [data.comments, seek, scrollToComment]);

  const refresh = useCallback(() => pageReq.mutate(), [pageReq]);
  const request = data.request;
  const open = request.status === "open" || request.status === "answered";

  return (
    <article className="space-y-5" data-testid="review-page">
      <Link href="/reviews" className="inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Review board
      </Link>

      <RequestHeader data={data} onChanged={refresh} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,440px)] xl:items-start">
        <div
          className={pinned ? "sticky top-[calc(50px+env(safe-area-inset-top,0px))] z-20 -mx-4 bg-bg px-4 pb-2 pt-1 sm:-mx-6 sm:px-6 xl:static xl:mx-0 xl:bg-transparent xl:p-0" : ""}
          data-testid="review-replay"
        >
          <ReviewReplayPanel
            requestId={id}
            hidden={data.request.hidden}
            analysis={analysisReq.data}
            analysisError={analysisReq.error}
            seekRequest={seekRequest}
            onTimeChange={setCurrentTime}
            onPlaybackAvailable={setPlaybackAvailable}
            mapMarkers={mapMarkers}
            onWorldClick={pickingFor ? onWorldClick : undefined}
            onMarkerClick={onMarkerClick}
            commentMarkers={commentMarkers}
            onCommentMarker={onCommentMarker}
          />
          <button
            type="button"
            onClick={() => setPinned((v) => !v)}
            className="mt-1 inline-flex min-h-[32px] items-center gap-1 text-micro font-semibold text-text-muted hover:text-text xl:hidden"
          >
            {pinned ? <PinOff className="h-3.5 w-3.5" aria-hidden /> : <Pin className="h-3.5 w-3.5" aria-hidden />}
            {pinned ? "Unpin replay" : "Pin replay to the top"}
          </button>
        </div>

        <div className="min-w-0 space-y-4">
          {open ? (
            <ComposerGate
              data={data}
              signedIn={Boolean(isSignedIn)}
              currentTime={currentTime}
              composing={composing}
              onStart={() => setComposing(currentTime)}
            />
          ) : (
            <p className="flex items-center gap-2 rounded-xl border-2 border-line bg-bg-surface p-3 text-body text-text-muted">
              <Lock className="h-4 w-4" aria-hidden /> This request is closed to new comments.
            </p>
          )}
          {composing !== null && data.viewer.canComment ? (
            <ReviewComposer
              key={composing}
              requestId={id}
              durationSec={duration}
              currentTime={currentTime}
              initialTime={composing}
              draftPin={draftPins.root ?? null}
              nextPinNumber={pins.size + 1}
              pinMode={pickingFor === "root"}
              canPin={playbackAvailable}
              onTogglePinMode={() => togglePin("root")}
              onClearPin={() => clearPin("root")}
              onCancel={() => { setComposing(null); clearPin("root"); }}
              onPosted={(commentId) => {
                setComposing(null);
                clearPin("root");
                void refresh().then(() => scrollToComment(commentId));
              }}
            />
          ) : null}
          <ReviewThread
            data={data}
            pinNumbers={pins}
            activeId={activeId}
            currentTime={currentTime}
            durationSec={duration}
            canPin={playbackAvailable}
            pinFor={(owner) => draftPins[owner] ?? null}
            pickingFor={pickingFor}
            onSeek={seek}
            onTogglePinMode={togglePin}
            onClearPin={clearPin}
            onChanged={refresh}
          />
        </div>
      </div>
    </article>
  );
}

export function RequestHeader({ data, onChanged }: { data: ReviewPageData; onChanged: () => Promise<unknown> }) {
  const { getToken, isSignedIn } = useAuth();
  const shareToggleId = useId();
  const [closing, setClosing] = useState(false);
  const closePending = useRef(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportNotice, setReportNotice] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const r = data.request;
  const active = r.status === "open" || r.status === "answered";
  async function setReplaySharing(value: boolean) {
    setSharing(true);
    setShareError(null);
    try {
      await apiCall(getToken, `/v1/reviews/${encodeURIComponent(r.id)}/replay-sharing`, { method: "POST", body: JSON.stringify({ value }) });
      await onChanged();
    } catch (err) {
      setShareError((err as { message?: string })?.message || "Couldn't change replay sharing.");
    } finally {
      setSharing(false);
    }
  }
  const headline = reviewHeadline(r.question, r.game.matchup);
  async function close() {
    if (closePending.current) return;
    closePending.current = true;
    setClosing(true);
    setCloseError(null);
    try {
      await apiCall(getToken, `/v1/reviews/${encodeURIComponent(r.id)}/close`, { method: "POST", body: "{}" });
      await onChanged();
    } catch (err) {
      setCloseError((err as { message?: string })?.message || "Couldn't close this request. Check your connection and try again.");
    } finally {
      closePending.current = false; setConfirmClose(false);
      setClosing(false);
    }
  }
  async function report(reason: string) {
    setReporting(true); setReportNotice(null); setReportError(null);
    try {
      const result = await apiCall<{ alreadyReported?: boolean }>(getToken, `/v1/reviews/${encodeURIComponent(r.id)}/report`, { method: "POST", body: JSON.stringify({ reason }) });
      setReportNotice(result?.alreadyReported ? "You already reported this request." : "Thanks — a moderator will take a look.");
    } catch (error) { setReportError((error as { message?: string })?.message || "Couldn't report this request. Try again."); }
    finally { setReporting(false); }
  }
  return (
    <><header className="relative rounded-xl border-2 border-line bg-bg-surface shadow-hard">
      <MapArtwork mapName={r.game.map} size="hero" eager className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl border-0 opacity-25" />
      <span aria-hidden className="absolute inset-0 rounded-xl bg-gradient-to-r from-bg-surface via-bg-surface/95 to-bg-surface/70" />
      <div className="relative space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          {r.game.matchup ? <Badge variant="accent" size="md">{r.game.matchup}</Badge> : null}
          {r.game.result ? <Badge variant={r.game.result === "Win" ? "success" : r.game.result === "Loss" ? "danger" : "neutral"} size="sm">{r.game.result}</Badge> : null}
          {r.status === "answered" ? <Badge variant="success" size="sm">Answered</Badge> : null}
          {r.status === "closed" ? <Badge variant="neutral" size="sm">Closed</Badge> : null}
          {r.visibility === "link" ? <Badge variant="neutral" size="sm">Link only</Badge> : null}
          {r.hidden ? <Badge variant="warning" size="sm">Hidden pending moderator review</Badge> : null}
        </div>
        <h1 className="break-words font-display text-h2 font-bold text-text">{headline}</h1>
        <p className="text-caption text-text-muted">
          Asked by <strong className="text-text">{r.asker.label}</strong>
          {r.asker.band ? <> · {r.asker.band.label}{r.asker.mmr ? ` (~${r.asker.mmr.toLocaleString("en-US")} MMR)` : ""}</> : null}
          {" "}vs {r.opponent.label}
          {r.game.map ? <> · {r.game.map}</> : null}
          {r.game.durationSec ? <> · {formatClock(r.game.durationSec)}</> : null}
        </p>
        {r.question.length > headline.length - (r.game.matchup ? r.game.matchup.length + 3 : 0) ? (
          <p className="whitespace-pre-line break-words text-body text-text">{r.question}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {r.tags.map((t) => <Badge key={t} variant="neutral" size="sm">{tagLabel(t)}</Badge>)}
          {r.timeRange ? <Badge variant="cyan" size="sm">Focus {formatClock(r.timeRange.startSec)}–{formatClock(r.timeRange.endSec)}</Badge> : null}
          <Badge variant="neutral" size="sm">Wants: {levelLabel(r.desiredLevel)}</Badge>
          {r.game.myBuild ? <Badge variant="neutral" size="sm">{r.game.myBuild}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {r.replay?.shared ? (
            <ReviewReplayDownload requestId={r.id} requestUrl={r.url} variant="page" available={r.replay.available} />
          ) : null}
          <ReviewShareMenu path={r.url} question={r.question} matchup={r.game.matchup} />
          {isSignedIn && !r.asker.isYou ? <ReviewMenu label="Request actions" disabled={reporting} items={[{ id: "report", label: "Report request…", items: REPORT_REASONS.map((reason) => ({ id: reason, label: reason, onSelect: () => report(reason) })) }]}><MoreHorizontal className="h-5 w-5" aria-hidden /></ReviewMenu> : null}
        </div>
        {reportNotice ? <p role="status" className="text-caption text-text-muted">{reportNotice}</p> : null}
        {reportError ? <p role="alert" className="text-caption text-danger">{reportError}</p> : null}
        {r.asker.isYou && active ? (
          <details className="rounded-lg border border-border bg-bg-surface/80 p-3"><summary className="min-h-10 cursor-pointer content-center text-caption font-semibold text-text">Asker tools</summary><div className="mt-2 space-y-3"><label htmlFor={shareToggleId} className="flex min-h-11 items-start gap-2 text-caption text-text-muted">
            <Toggle
              id={shareToggleId}
              label="Let reviewers download my replay file"
              // The saved choice, not the effective state: while the request
              // is hidden downloads pause, but the asker can still turn it off.
              checked={r.replay?.optedIn ?? r.replay?.shared === true}
              disabled={sharing}
              onChange={(value) => void setReplaySharing(value)}
              className="mt-0.5"
            />
            <span>
              Let reviewers download my replay file.{" "}
              <span className="text-text-dim">It contains both players&apos; in-game names and any in-game chat, including yours, even when you post anonymously. Turning this off stops new downloads.</span>
              {r.replay?.optedIn && r.hidden ? (
                <span className="block text-text-dim">Downloads are paused while this request is hidden pending moderator review.</span>
              ) : null}
              {shareError ? <span role="alert" className="block text-danger">{shareError}</span> : null}
            </span>
          </label><Button variant="ghost" size="sm" loading={closing} onClick={() => setConfirmClose(true)}>Close request</Button>
            {closeError ? <p role="alert" className="text-danger">{closeError} <Button variant="ghost" size="sm" loading={closing} onClick={() => void close()}>Try again</Button></p> : null}
          </div></details>
        ) : null}
        {r.status === "closed" && r.closedReason === "game_unavailable" ? (
          <p className="text-caption text-text-muted">The asker removed this game, so its replay is no longer shared.</p>
        ) : null}
      </div>
    </header><ConfirmDialog open={confirmClose} onClose={() => { if (!closePending.current) setConfirmClose(false); }} onConfirm={() => void close()} loading={closing} intent="danger" title="Close this request?" description="New comments stop and the replay analysis is no longer shared. The thread stays readable. You can't reopen it." confirmLabel="Close request" /></>
  );
}

const GATE_CLASS = "rounded-xl border-2 border-line bg-bg-surface p-3 text-body text-text-muted";
const GATE_LINK_CLASS = "inline-flex min-h-9 items-center text-caption font-semibold";

/** "Why?" next to a gate: the article section on who can review. */
function WhyLink() {
  return (
    <LazyHelpLink slug="replay-reviews" anchor="who-can-review" className={GATE_LINK_CLASS}>
      Why?<span className="sr-only"> Who can review replays</span>
    </LazyHelpLink>
  );
}

/**
 * What sits above the thread: Sign in, the reason you can't comment yet
 * (with the way to fix it and a "Why?" into the help article), or the
 * "Comment at 5:12" button. Exported for tests.
 */
export function ComposerGate({
  data,
  signedIn,
  currentTime,
  composing,
  onStart,
}: {
  data: ReviewPageData;
  signedIn: boolean;
  currentTime: number;
  composing: number | null;
  onStart: () => void;
}) {
  const v = data.viewer;
  if (!signedIn || !v.signedIn) {
    return (
      <div className="rounded-xl border-2 border-line bg-bg-surface p-3 text-body text-text-muted">
        <Link href={`/sign-in?redirect_url=${encodeURIComponent(data.request.url)}`} className="font-semibold text-accent-cyan underline underline-offset-2 hover:text-accent-hover">Sign in</Link>
        {" "}to comment, vote or mark reviews helpful.
      </div>
    );
  }
  if (!v.canComment) {
    if (v.reason === "min_games") {
      return (
        <div role="status" className={GATE_CLASS}>
          <p>
            Sync at least {v.requiredGames ?? REVIEW_LIMITS.MIN_SYNCED_GAMES} games with the desktop app to review replays (you have {v.syncedGames ?? 0}).
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-4">
            <Link href="/download" className={`${GATE_LINK_CLASS} text-accent-cyan underline underline-offset-2 hover:text-accent-hover`}>
              Get the desktop app
            </Link>
            <WhyLink />
          </p>
        </div>
      );
    }
    const reason = v.reason === "blocked"
      ? "The asker isn't accepting comments from you."
      : v.reason === "browser_session_required"
        ? "Sign in on the website to comment."
        : "Comments are closed.";
    return <p role="status" className={GATE_CLASS}>{reason}</p>;
  }
  if (!v.isAsker && v.canReview === false) {
    const level = data.request.desiredLevel;
    const wanted = level === "my_league_or_higher" ? "players at their league or higher" : `${levelLabel(level)} players`;
    return (
      <div role="status" className={GATE_CLASS}>
        <p>
          The asker wants reviews from verified {wanted}, so you can reply to existing reviews but not start a new one.
        </p>
        <p className="mt-1">
          <WhyLink />
        </p>
      </div>
    );
  }
  if (composing !== null) return null;
  return (
    <Button iconLeft={<MessageSquarePlus className="h-4 w-4" aria-hidden />} onClick={onStart} fullWidth>
      {v.isAsker ? `Add a note at ${formatClock(currentTime)}` : `Comment at ${formatClock(currentTime)}`}
    </Button>
  );
}

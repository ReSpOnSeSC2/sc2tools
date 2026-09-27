"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { ArrowLeft, Lock, MessageSquarePlus, Pin, PinOff } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
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
  reviewHeadline,
  tagLabel,
  type ReviewAnalysis,
  type ReviewPageData,
} from "@/lib/reviews";
import { ReviewComposer, type DraftPin } from "./ReviewComposer";
import { ReviewReplayPanel } from "./ReviewReplayPanel";
import { ReviewShareMenu } from "./ReviewShareMenu";
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
  );

  const [currentTime, setCurrentTime] = useState(0);
  const [seekRequest, setSeekRequest] = useState<{ t: number; seq: number } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pinMode, setPinMode] = useState(false);
  const [draftPin, setDraftPin] = useState<DraftPin | null>(null);
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
    if (draftPin) out.push({ id: "__draft__", x: draftPin.x, y: draftPin.y, t: draftPin.t, label: "+", draft: true });
    return out;
  }, [data.comments, pins, activeId, draftPin]);

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
    setDraftPin({ x, y, t });
    setPinMode(false);
  }, []);

  const onMarkerClick = useCallback((markerId: string) => {
    if (markerId === "__draft__") return;
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
          className={pinned ? "sticky top-[50px] z-20 -mx-4 bg-bg px-4 pb-2 pt-1 sm:-mx-6 sm:px-6 xl:static xl:mx-0 xl:bg-transparent xl:p-0" : ""}
          data-testid="review-replay"
        >
          <ReviewReplayPanel
            requestId={id}
            analysis={analysisReq.data}
            analysisError={analysisReq.error}
            seekRequest={seekRequest}
            onTimeChange={setCurrentTime}
            onPlaybackAvailable={setPlaybackAvailable}
            mapMarkers={mapMarkers}
            onWorldClick={pinMode ? onWorldClick : undefined}
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
              draftPin={draftPin}
              pinMode={pinMode}
              canPin={playbackAvailable}
              onTogglePinMode={() => setPinMode((v) => !v)}
              onClearPin={() => setDraftPin(null)}
              onCancel={() => { setComposing(null); setDraftPin(null); setPinMode(false); }}
              onPosted={(commentId) => {
                setComposing(null);
                setDraftPin(null);
                setPinMode(false);
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
            draftPin={draftPin}
            pinMode={pinMode}
            onSeek={seek}
            onTogglePinMode={() => setPinMode((v) => !v)}
            onClearPin={() => setDraftPin(null)}
            onChanged={refresh}
          />
        </div>
      </div>
    </article>
  );
}

function RequestHeader({ data, onChanged }: { data: ReviewPageData; onChanged: () => Promise<unknown> }) {
  const { getToken } = useAuth();
  const [closing, setClosing] = useState(false);
  const r = data.request;
  const headline = reviewHeadline(r.question, r.game.matchup);
  async function close() {
    if (!window.confirm("Close this request? New comments stop and the replay analysis is no longer shared. The thread stays readable.")) return;
    setClosing(true);
    try {
      await apiCall(getToken, `/v1/reviews/${encodeURIComponent(r.id)}/close`, { method: "POST", body: "{}" });
      await onChanged();
    } finally {
      setClosing(false);
    }
  }
  return (
    <header className="relative overflow-hidden rounded-xl border-2 border-line bg-bg-surface shadow-hard">
      <MapArtwork mapName={r.game.map} size="hero" eager className="pointer-events-none absolute inset-0 border-0 opacity-25" />
      <span aria-hidden className="absolute inset-0 bg-gradient-to-r from-bg-surface via-bg-surface/95 to-bg-surface/70" />
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
          <ReviewShareMenu path={r.url} question={r.question} matchup={r.game.matchup} />
          {r.asker.isYou && (r.status === "open" || r.status === "answered") ? (
            <Button variant="ghost" size="sm" loading={closing} onClick={() => void close()}>Close request</Button>
          ) : null}
        </div>
        {r.status === "closed" && r.closedReason === "game_unavailable" ? (
          <p className="text-caption text-text-muted">The asker removed this game, so its replay is no longer shared.</p>
        ) : null}
      </div>
    </header>
  );
}

function ComposerGate({
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
        <Link href={`/sign-in?redirect_url=${encodeURIComponent(data.request.url)}`} className="font-semibold text-accent-cyan underline underline-offset-2">Sign in</Link>
        {" "}to comment, vote or mark reviews helpful.
      </div>
    );
  }
  if (!v.canComment) {
    const reason = v.reason === "min_games"
      ? `Sync at least ${v.requiredGames ?? 20} games with the desktop agent to review replays (you have ${v.syncedGames ?? 0}).`
      : v.reason === "blocked"
        ? "The asker isn't accepting comments from you."
        : v.reason === "browser_session_required"
          ? "Sign in on the website to comment."
          : "Comments are closed.";
    return <p role="status" className="rounded-xl border-2 border-line bg-bg-surface p-3 text-body text-text-muted">{reason}</p>;
  }
  if (!v.isAsker && v.canReview === false) {
    return (
      <p role="status" className="rounded-xl border-2 border-line bg-bg-surface p-3 text-body text-text-muted">
        The asker wants reviews from verified {levelLabel(data.request.desiredLevel)} players, so you can reply to existing reviews but not start a new one.
      </p>
    );
  }
  if (composing !== null) return null;
  return (
    <Button iconLeft={<MessageSquarePlus className="h-4 w-4" aria-hidden />} onClick={onStart} fullWidth>
      {v.isAsker ? `Add a note at ${formatClock(currentTime)}` : `Comment at ${formatClock(currentTime)}`}
    </Button>
  );
}

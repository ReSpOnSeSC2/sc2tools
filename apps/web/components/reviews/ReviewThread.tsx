"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { CheckCircle2, MapPin, MoreHorizontal, Star, ThumbsUp } from "lucide-react";
import { apiCall } from "@/lib/clientApi";
import { gaEvent } from "@/lib/analytics/gtag";
import { ReviewMarkdown } from "@/lib/reviewMarkdown";
import type { ReviewComment, ReviewPageData } from "@/lib/reviews";
import { ReviewComposer, type DraftPin } from "./ReviewComposer";
import { CommentEditor } from "./CommentEditor";
import { ReviewerBadges } from "./ReviewerBadges";
import { TimeChip } from "./TimeChip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { REPORT_REASONS, ReviewMenu, type ReviewMenuItem } from "./ReviewMenu";
import { CommentTime } from "./CommentTime";

type ThreadOrder = "top" | "timeline";

export type ThreadContext = {
  data: ReviewPageData;
  pinNumbers: Map<string, number>;
  activeId: string | null;
  currentTime: number;
  durationSec: number | null;
  canPin: boolean;
  pinFor: (owner: string) => DraftPin | null;
  pickingFor: string | null;
  onSeek: (seconds: number, commentId?: string) => void;
  onTogglePinMode: (owner: string) => void;
  onClearPin: (owner: string) => void;
  onChanged: () => void | Promise<unknown>;
};

/**
 * The review thread: top-level reviews with one level of replies.
 * "Top" puts the asker's best pick first, then helpful, then upvotes;
 * "Timeline" follows the replay clock.
 */
export function ReviewThread(ctx: ThreadContext) {
  const [order, setOrder] = useState<ThreadOrder>("top");
  const { data } = ctx;
  const { topLevel, replies } = useMemo(() => {
    const top = data.comments.filter((c) => !c.parentId);
    const byParent = new Map<string, ReviewComment[]>();
    for (const c of data.comments) {
      if (!c.parentId) continue;
      const list = byParent.get(c.parentId) ?? [];
      list.push(c);
      byParent.set(c.parentId, list);
    }
    const score = (c: ReviewComment) => (c.best ? 1e6 : 0) + (c.helpful ? 1e4 : 0) + c.upvotes;
    const sorted = [...top].sort((a, b) =>
      order === "timeline"
        ? (a.gameTimeSec ?? Infinity) - (b.gameTimeSec ?? Infinity)
        : score(b) - score(a) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
    );
    return { topLevel: sorted, replies: byParent };
  }, [data.comments, order]);

  return (
    <section aria-labelledby="review-thread-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="review-thread-title" className="font-display text-h3 font-bold text-text">
          {data.request.stats.reviewCount === 1 ? "1 review" : `${data.request.stats.reviewCount} reviews`}
        </h2>
        <div role="group" aria-label="Order reviews" className="inline-flex rounded-full border-2 border-line p-0.5 text-caption font-semibold">
          {(["top", "timeline"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={order === key}
              onClick={() => setOrder(key)}
              className={`min-h-[32px] rounded-full px-3 ${order === key ? "bg-accent text-white" : "text-text-muted hover:text-text"}`}
            >
              {key === "top" ? "Top" : "Timeline"}
            </button>
          ))}
        </div>
      </div>
      {topLevel.length === 0 ? (
        <p className="rounded-xl border-2 border-dashed border-border p-4 text-body text-text-muted">
          No reviews yet. Scrub to a moment that matters and leave the first one.
        </p>
      ) : (
        <ol className="space-y-3">
          {topLevel.map((c) => (
            <li key={c.id}>
              <CommentCard comment={c} ctx={ctx} />
              {(replies.get(c.id) ?? []).length ? (
                <ol className="ml-4 mt-2 space-y-2 border-l-2 border-border pl-3 sm:ml-6">
                  {(replies.get(c.id) ?? []).map((r) => (
                    <li key={r.id}><CommentCard comment={r} ctx={ctx} isReply /></li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CommentCard({ comment: c, ctx, isReply = false }: { comment: ReviewComment; ctx: ThreadContext; isReply?: boolean }) {
  const { getToken, isSignedIn } = useAuth();
  const { data } = ctx;
  const requestId = data.request.id;
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "block" | null>(null);
  const pin = ctx.pinNumbers.get(c.id);
  const active = ctx.activeId === c.id;
  const base = `/v1/reviews/${encodeURIComponent(requestId)}/comments/${encodeURIComponent(c.id)}`;
  const isAsker = data.viewer.isAsker;
  const open = data.request.status === "open" || data.request.status === "answered";

  /** Keep the parsed response, including the report route's alreadyReported flag. */
  async function act(path: string, body: Record<string, unknown> = {}, method = "POST", event?: string): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setNotice(null);
    setNoticeError(false);
    try {
      const result = await apiCall<Record<string, unknown>>(getToken, `${base}${path}`, { method, body: method === "DELETE" ? undefined : JSON.stringify(body) });
      if (event) gaEvent(event);
      await ctx.onChanged();
      return result ?? {};
    } catch (err) {
      setNotice((err as { message?: string })?.message || "That didn't work.");
      setNoticeError(true);
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (c.state === "deleted" || c.state === "removed" || c.state === "blocked") {
    const text = c.state === "deleted"
      ? "[deleted]"
      : c.state === "blocked"
        ? "Hidden — you blocked this reviewer."
        : "[removed by a moderator]";
    return <p id={`comment-${c.id}`} className="rounded-xl border border-border bg-bg-elevated/40 px-3 py-2 text-caption italic text-text-dim">{text}</p>;
  }

  const author = c.author;
  const menuItems: ReviewMenuItem[] = [];
  if (isSignedIn && !c.mine && author) {
    menuItems.push({ id: "report", label: "Report…", items: REPORT_REASONS.map((reason) => ({ id: reason, label: reason, onSelect: async () => {
      const result = await act("/report", { reason }, "POST", "review_report");
      if (result) setNotice(result.alreadyReported ? "You already reported this comment." : "Thanks — a moderator will take a look.");
    } })) });
    if (!author.isAsker) menuItems.push({ id: "block", label: "Block reviewer", onSelect: () => setConfirm("block") });
  }
  return (
    <article
      id={`comment-${c.id}`}
      aria-label={author ? `Comment by ${author.label}` : "Comment"}
      data-testid="review-comment"
      className={[
        "scroll-mt-[55vh] space-y-2 rounded-xl border-2 bg-bg-surface p-3 xl:scroll-mt-24",
        c.best ? "border-success" : active ? "border-accent-cyan" : "border-line",
        c.state === "hidden" ? "opacity-70" : "",
      ].join(" ")}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {pin ? (
          <span aria-label={`Map pin ${pin}`} className="grid h-6 w-6 place-items-center rounded-full bg-accent-cyan font-mono text-micro font-bold text-bg">
            {pin}
          </span>
        ) : null}
        {author?.profileHref ? (
          <Link href={author.profileHref} className="font-semibold text-text hover:underline">{author.label}</Link>
        ) : (
          <span className="font-semibold text-text">{author?.label ?? "SC2 Player"}</span>
        )}
        {author ? <ReviewerBadges author={author} /> : null}
        {c.createdAt ? <CommentTime createdAt={c.createdAt} editedAt={c.editedAt} /> : null}
        {c.best ? (
          <span className="inline-flex items-center gap-1 text-caption font-bold text-success"><Star className="h-3.5 w-3.5" aria-hidden /> Best review</span>
        ) : c.helpful ? (
          <span className="inline-flex items-center gap-1 text-caption font-semibold text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Helpful</span>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {c.gameTimeSec !== null ? (
          <TimeChip startSec={c.gameTimeSec} endSec={c.endTimeSec} onSeek={(t) => ctx.onSeek(t, c.id)} active={active} />
        ) : null}
        {c.mapPoint && pin ? (
          <span className="inline-flex items-center gap-1 text-caption text-text-muted"><MapPin className="h-3.5 w-3.5" aria-hidden /> Pinned on the map</span>
        ) : null}
        {c.state === "hidden" ? (
          <span className="text-caption font-semibold text-warning">Hidden pending moderator review</span>
        ) : null}
      </div>

      {editing ? (
        <CommentEditor comment={c} durationSec={ctx.durationSec} onCancel={() => setEditing(false)} onSave={(body) => act("", { body }, "PATCH").then(Boolean)} />
      ) : (
        <ReviewMarkdown text={c.body} onSeek={(t) => ctx.onSeek(t, c.id)} maxSeconds={ctx.durationSec} />
      )}

      <footer className="flex flex-wrap items-center gap-1 text-caption">
        {author?.isAsker ? null : isSignedIn && !c.mine ? (
          <button
            type="button"
            disabled={busy}
            aria-pressed={c.upvoted}
            onClick={() => void act("/upvote", { value: !c.upvoted }, "POST", c.upvoted ? undefined : "review_upvote")}
            className={`inline-flex min-h-[32px] items-center gap-1 rounded-full px-2 font-semibold ${c.upvoted ? "text-accent-cyan" : "text-text-muted hover:text-text"}`}
          >
            <ThumbsUp className="h-3.5 w-3.5" aria-hidden /> {c.upvotes}
            <span className="sr-only">{c.upvoted ? "Remove upvote" : "Upvote"}</span>
          </button>
        ) : (
          <span className="inline-flex min-h-[32px] items-center gap-1 px-2 text-text-dim" title={isSignedIn ? undefined : "Sign in to upvote"}>
            <ThumbsUp className="h-3.5 w-3.5" aria-hidden /> {c.upvotes}
          </span>
        )}
        {isAsker && !author?.isAsker ? (
          <button type="button" disabled={busy} aria-pressed={c.helpful} onClick={() => void act("/helpful", { value: !c.helpful }, "POST", c.helpful ? undefined : "review_helpful")} className="min-h-[32px] rounded-full px-2 font-semibold text-text-muted hover:text-success">
            {c.helpful ? "Unmark helpful" : "Helpful"}
          </button>
        ) : null}
        {isAsker && !isReply && !author?.isAsker && open ? (
          <button type="button" disabled={busy} aria-pressed={c.best} onClick={() => void act("/best", { value: !c.best }, "POST", c.best ? undefined : "review_best")} className="min-h-[32px] rounded-full px-2 font-semibold text-text-muted hover:text-success">
            {c.best ? "Unmark best" : "Best review"}
          </button>
        ) : null}
        {!isReply && data.viewer.canComment ? (
          <button type="button" onClick={() => { if (replying) ctx.onClearPin(c.id); setReplying((v) => !v); }} className="min-h-[32px] rounded-full px-2 font-semibold text-text-muted hover:text-text">Reply</button>
        ) : null}
        {c.canEdit && !editing ? (
          <button type="button" onClick={() => setEditing(true)} className="min-h-[32px] rounded-full px-2 font-semibold text-text-muted hover:text-text">Edit</button>
        ) : null}
        {c.mine ? (
          <button type="button" disabled={busy} onClick={() => setConfirm("delete")} className="min-h-[32px] rounded-full px-2 font-semibold text-text-muted hover:text-danger">Delete</button>
        ) : null}
        <ReviewMenu label="More actions" disabled={busy} items={menuItems}><MoreHorizontal className="h-4 w-4" aria-hidden /></ReviewMenu>
        {notice ? <span role={noticeError ? "alert" : "status"} className={`basis-full text-micro ${noticeError ? "text-danger" : "text-text-muted"}`}>{notice}</span> : null}
      </footer>

      {replying ? (
        <ReviewComposer
          requestId={requestId}
          durationSec={ctx.durationSec}
          currentTime={ctx.currentTime}
          initialTime={c.gameTimeSec ?? ctx.currentTime}
          parentId={c.id}
          draftPin={ctx.pinFor(c.id)}
          nextPinNumber={ctx.pinNumbers.size + 1}
          pinMode={ctx.pickingFor === c.id}
          onTogglePinMode={() => ctx.onTogglePinMode(c.id)}
          onClearPin={() => ctx.onClearPin(c.id)}
          canPin={ctx.canPin}
          onCancel={() => { setReplying(false); ctx.onClearPin(c.id); }}
          onPosted={() => {
            setReplying(false);
            ctx.onClearPin(c.id);
            void ctx.onChanged();
          }}
        />
      ) : null}
      <ConfirmDialog open={confirm !== null} onClose={() => { if (!busy) setConfirm(null); }} intent="danger" loading={busy}
        title={confirm === "delete" ? "Delete this comment?" : `Block ${author?.label ?? "this reviewer"}?`}
        description={confirm === "delete" ? "It's replaced by [deleted] for everyone. Replies stay." : "You won't see their comments on any request or get notified about them. Undo it in My reviews > Blocked reviewers."}
        confirmLabel={confirm === "delete" ? "Delete" : "Block"}
        onConfirm={() => { void (async () => { const result = await act(confirm === "delete" ? "" : "/block", {}, confirm === "delete" ? "DELETE" : "POST"); setConfirm(null); if (result && confirm === "block") setNotice(`You won't see ${author?.label}'s comments any more.`); })(); }} />
    </article>
  );
}

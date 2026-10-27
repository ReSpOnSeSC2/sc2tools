"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Clock, MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { clearDraft, loadDraft, saveDraft } from "@/lib/reviewDrafts";
import { useReviewShortcutLabel } from "./useReviewShortcutLabel";
import { apiCall, useOwnerRequestScope } from "@/lib/clientApi";
import { gaEvent } from "@/lib/analytics/gtag";
import {
  REVIEW_LIMITS,
  formatClock,
  validateComment,
} from "@/lib/reviews";

export type DraftPin = { x: number; y: number; t: number };

/**
 * Write a timestamped (and optionally map-pinned) comment.
 *
 * The moment is captured, not typed: "Comment at 5:12" freezes the
 * replay clock when the reviewer starts, "Use current time" re-captures
 * it, and "End range here" turns it into 5:12–5:40. The map pin comes
 * from the replayer's ``onWorldClick`` while pin mode is on. Validation
 * mirrors the API so the rules are explained before a round trip.
 */
type Props = {
  requestId: string;
  durationSec: number | null;
  /** The replay clock right now (for "Use current time"). */
  currentTime: number;
  /** Frozen at the moment the composer opened. */
  initialTime: number;
  parentId?: string | null;
  draftPin: DraftPin | null;
  nextPinNumber?: number;
  pinMode: boolean;
  onTogglePinMode: () => void;
  onClearPin: () => void;
  onPosted: (commentId: string) => void;
  onCancel?: () => void;
  /** False when there is no map playback to pin on. */
  canPin: boolean;
};

export function ReviewComposer(props: Props) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const ownerId = isLoaded && isSignedIn && userId ? userId : null;
  if (!ownerId) return null;
  return <OwnedReviewComposer key={JSON.stringify([ownerId, props.requestId, props.parentId ?? null])} {...props} ownerId={ownerId} getToken={getToken} />;
}

function OwnedReviewComposer({
  requestId, durationSec, currentTime, initialTime, parentId = null, draftPin,
  nextPinNumber = 1, pinMode, onTogglePinMode, onClearPin, onPosted, onCancel, canPin,
  ownerId, getToken,
}: Props & { ownerId: string; getToken: () => Promise<string | null> }) {
  const runOwned = useOwnerRequestScope(ownerId, getToken);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const bodyId = useId();
  const [body, setBody] = useState("");
  const [start, setStart] = useState(() => roundTenth(initialTime));
  const [end, setEnd] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [restored, setRestored] = useState(false);
  const shortcut = useReviewShortcutLabel();
  const initial = useRef({ initialTime, durationSec });

  useEffect(() => {
    const saved = loadDraft(ownerId, requestId, parentId);
    if (!saved) return;
    setBody(saved.body);
    const fits = !validateComment({ body: "Restored review text.", gameTimeSec: saved.start, endTimeSec: saved.end }, initial.current.durationSec);
    if (fits) { setStart(saved.start); setEnd(saved.end); }
    setRestored(true);
  }, [ownerId, requestId, parentId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (body.trim()) saveDraft(ownerId, requestId, parentId, { body, start, end });
      else clearDraft(ownerId, requestId, parentId);
    }, 500);
    return () => clearTimeout(timer);
  }, [body, start, end, ownerId, requestId, parentId]);

  function discard(cancel = false) {
    clearDraft(ownerId, requestId, parentId); setBody(""); setStart(roundTenth(initial.current.initialTime)); setEnd(null);
    setRestored(false); setError(null); setTouched(false); setConfirmDiscard(false); onClearPin();
    if (cancel) onCancel?.();
  }

  const draft = { body, gameTimeSec: start, endTimeSec: end };
  const problem = validateComment(draft, durationSec);
  const remaining = REVIEW_LIMITS.COMMENT_MAX - body.trim().length;

  async function submit() {
    if (submitting.current) return;
    setTouched(true);
    if (problem) {
      setError(problem);
      return;
    }
    submitting.current = true; setBusy(true);
    setError(null);
    try {
      const res = await runOwned(ownerId, (scopedToken, signal) => apiCall<{ id: string }>(scopedToken, `/v1/reviews/${encodeURIComponent(requestId)}/comments`, {
        method: "POST",
        signal,
        body: JSON.stringify({
          body: body.trim(),
          gameTimeSec: start,
          endTimeSec: end,
          mapPoint: draftPin ? { x: roundTenth(draftPin.x), y: roundTenth(draftPin.y) } : null,
          parentId,
        }),
      }));
      if (!mounted.current) return;
      gaEvent("review_comment_posted", { reply: Boolean(parentId), pinned: Boolean(draftPin), ranged: end !== null });
      clearDraft(ownerId, requestId, parentId); setRestored(false);
      setBody("");
      setEnd(null);
      setTouched(false);
      onPosted(res.id);
    } catch (err) {
      if (mounted.current) setError((err as { message?: string })?.message || "Couldn't post your comment.");
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <><form
      className="space-y-3 rounded-xl border-2 border-line bg-bg-surface p-3 shadow-hard"
      aria-label={parentId ? "Reply" : "Write a review comment"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {restored ? <p role="status" className="flex flex-wrap items-center gap-2 text-caption text-text-muted">Draft restored (at {formatClock(start)}) · <button type="button" className="min-h-10 font-semibold text-link hover:underline" onClick={() => { setStart(roundTenth(currentTime)); setEnd(null); }}>Use current time</button> · <button type="button" className="min-h-10 font-semibold text-link hover:underline" onClick={() => discard()}>Discard</button></p> : null}
      <div className="flex flex-wrap items-center gap-2 text-caption">
        <span className="inline-flex min-h-[32px] items-center gap-1 rounded-full border border-accent-cyan/60 bg-accent-cyan/15 px-2.5 font-mono font-semibold tabular-nums text-text" data-testid="composer-time">
          <Clock className="h-3.5 w-3.5 text-accent-cyan" aria-hidden />
          {end !== null ? `${formatClock(start)}–${formatClock(end)}` : `at ${formatClock(start)}`}
        </span>
        <button type="button" onClick={() => { setStart(roundTenth(currentTime)); if (end !== null && end <= currentTime) setEnd(null); }} className="min-h-[32px] rounded-full px-2 font-semibold text-accent-cyan hover:underline">
          Use current time ({formatClock(currentTime)})
        </button>
        {end === null ? (
          <button
            type="button"
            onClick={() => setEnd(roundTenth(currentTime))}
            disabled={!(currentTime > start)}
            title={currentTime > start ? undefined : "Play or scrub past the start first"}
            className="min-h-[32px] rounded-full px-2 font-semibold text-text-muted hover:text-text disabled:opacity-50"
          >
            End range here
          </button>
        ) : (
          <button type="button" onClick={() => setEnd(null)} className="min-h-[32px] rounded-full px-2 font-semibold text-text-muted hover:text-text">
            Remove range
          </button>
        )}
      </div>

      {canPin ? (
        <div className="flex flex-wrap items-center gap-2 text-caption">
          {draftPin ? (
            <span className="inline-flex min-h-[32px] items-center gap-1 rounded-full border border-warning/60 bg-warning/10 px-2.5 font-semibold text-text" data-testid="composer-pin">
              <MapPin className="h-3.5 w-3.5 text-warning" aria-hidden />
              Pinned on map · becomes pin {nextPinNumber}
              <button type="button" onClick={onClearPin} aria-label="Remove map pin" className="ml-1 rounded-full p-0.5 hover:bg-bg-elevated">
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ) : null}
          <button
            type="button"
            onClick={onTogglePinMode}
            aria-pressed={pinMode}
            className={`inline-flex min-h-[32px] items-center gap-1 rounded-full border px-2.5 font-semibold ${pinMode ? "border-warning bg-warning/15 text-text" : "border-border text-text-muted hover:text-text"}`}
          >
            <MapPin className="h-3.5 w-3.5" aria-hidden />
            {pinMode ? "Click the map to place the pin…" : draftPin ? "Move pin" : "Pin a spot on the map"}
          </button>
        </div>
      ) : null}

      <div>
        <label htmlFor={bodyId} className="sr-only">Comment</label>
        <textarea
          id={bodyId}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => setTouched(true)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault(); if (!submitting.current) void submit();
            }
          }}
          rows={parentId ? 3 : 4}
          maxLength={REVIEW_LIMITS.COMMENT_MAX + 200}
          placeholder={parentId ? "Reply…" : "What happened here, and what should they do instead? **bold**, *italic*, lists and links work; times like 5:40 become jump links."}
          className="w-full resize-y rounded-lg border-2 border-line bg-bg px-3 py-2 text-body text-text placeholder:text-text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-invalid={touched && Boolean(problem)}
          aria-describedby={`${bodyId}-help`}
        />
        <div id={`${bodyId}-help`} className="mt-1 flex items-center justify-between gap-2 text-micro">
          <span role={error ? "alert" : undefined} className={error || (touched && problem) ? "text-danger" : "text-text-dim"}>
            {error || (touched && problem) || `At least ${REVIEW_LIMITS.COMMENT_MIN} characters · ${shortcut} to post`}
          </span>
          <span className={remaining < 0 ? "text-danger" : "text-text-dim"}>{remaining}</span>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { if (body.trim()) setConfirmDiscard(true); else discard(true); }}>Cancel</Button>
        ) : null}
        <Button type="submit" size="sm" loading={busy} disabled={busy} aria-keyshortcuts="Control+Enter Meta+Enter">
          {parentId ? "Reply" : `Comment at ${formatClock(start)}`}
        </Button>
      </div>
    </form><ConfirmDialog open={confirmDiscard} onClose={() => setConfirmDiscard(false)} onConfirm={() => discard(true)} intent="danger" focusCancel title="Discard this comment?" description="Your text will be removed from this browser." confirmLabel="Discard" cancelLabel="Keep editing" /></>
  );
}

function roundTenth(n: number) {
  return Math.round(Math.max(0, n) * 10) / 10;
}

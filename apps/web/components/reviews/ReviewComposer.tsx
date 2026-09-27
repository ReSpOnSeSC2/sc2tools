"use client";

import { useId, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Clock, MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { apiCall } from "@/lib/clientApi";
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
export function ReviewComposer({
  requestId,
  durationSec,
  currentTime,
  initialTime,
  parentId = null,
  draftPin,
  pinMode,
  onTogglePinMode,
  onClearPin,
  onPosted,
  onCancel,
  canPin,
}: {
  requestId: string;
  durationSec: number | null;
  /** The replay clock right now (for "Use current time"). */
  currentTime: number;
  /** Frozen at the moment the composer opened. */
  initialTime: number;
  parentId?: string | null;
  draftPin: DraftPin | null;
  pinMode: boolean;
  onTogglePinMode: () => void;
  onClearPin: () => void;
  onPosted: (commentId: string) => void;
  onCancel?: () => void;
  /** False when there is no map playback to pin on. */
  canPin: boolean;
}) {
  const { getToken } = useAuth();
  const bodyId = useId();
  const [body, setBody] = useState("");
  const [start, setStart] = useState(() => roundTenth(initialTime));
  const [end, setEnd] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const draft = { body, gameTimeSec: start, endTimeSec: end };
  const problem = validateComment(draft, durationSec);
  const remaining = REVIEW_LIMITS.COMMENT_MAX - body.trim().length;

  async function submit() {
    setTouched(true);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiCall<{ id: string }>(getToken, `/v1/reviews/${encodeURIComponent(requestId)}/comments`, {
        method: "POST",
        body: JSON.stringify({
          body: body.trim(),
          gameTimeSec: start,
          endTimeSec: end,
          mapPoint: draftPin ? { x: roundTenth(draftPin.x), y: roundTenth(draftPin.y) } : null,
          parentId,
        }),
      });
      gaEvent("review_comment_posted", { reply: Boolean(parentId), pinned: Boolean(draftPin), ranged: end !== null });
      setBody("");
      setEnd(null);
      setTouched(false);
      onPosted(res.id);
    } catch (err) {
      setError((err as { message?: string })?.message || "Couldn't post your comment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-3 rounded-xl border-2 border-line bg-bg-surface p-3 shadow-hard"
      aria-label={parentId ? "Reply" : "Write a review comment"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
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
              Pin at ({Math.round(draftPin.x)}, {Math.round(draftPin.y)})
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
          rows={parentId ? 3 : 4}
          maxLength={REVIEW_LIMITS.COMMENT_MAX + 200}
          placeholder={parentId ? "Reply…" : "What happened here, and what should they do instead? **bold**, *italic*, lists and links work; times like 5:40 become jump links."}
          className="w-full resize-y rounded-lg border-2 border-line bg-bg px-3 py-2 text-body text-text placeholder:text-text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-invalid={touched && Boolean(problem)}
          aria-describedby={`${bodyId}-help`}
        />
        <div id={`${bodyId}-help`} className="mt-1 flex items-center justify-between gap-2 text-micro">
          <span role={error ? "alert" : undefined} className={error || (touched && problem) ? "text-danger" : "text-text-dim"}>
            {error || (touched && problem) || `At least ${REVIEW_LIMITS.COMMENT_MIN} characters. No raw HTML.`}
          </span>
          <span className={remaining < 0 ? "text-danger" : "text-text-dim"}>{remaining}</span>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        ) : null}
        <Button type="submit" size="sm" loading={busy} disabled={busy}>
          {parentId ? "Reply" : `Comment at ${formatClock(start)}`}
        </Button>
      </div>
    </form>
  );
}

function roundTenth(n: number) {
  return Math.round(Math.max(0, n) * 10) / 10;
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { REVIEW_LIMITS, validateComment, type ReviewComment } from "@/lib/reviews";
import { useReviewShortcutLabel } from "./useReviewShortcutLabel";

export function CommentEditor({ comment, durationSec, onSave, onCancel }: {
  comment: ReviewComment; durationSec: number | null;
  onSave: (body: string) => Promise<boolean>; onCancel: () => void;
}) {
  const id = useId();
  const [body, setBody] = useState(comment.body);
  const [now, setNow] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const shortcut = useReviewShortcutLabel();
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const created = comment.createdAt ? Date.parse(comment.createdAt) : NaN;
  const remainingMs = Number.isFinite(created) && now !== null ? created + REVIEW_LIMITS.EDIT_WINDOW_MS - now : null;
  const expired = remainingMs !== null && remainingMs <= 0;
  const problem = validateComment({ body, gameTimeSec: comment.gameTimeSec, endTimeSec: comment.endTimeSec }, durationSec);
  const remaining = REVIEW_LIMITS.COMMENT_MAX - body.trim().length;

  async function save() {
    if (saving.current || expired) return;
    setTouched(true); setError(null);
    if (problem) return;
    saving.current = true; setBusy(true);
    try { if (await onSave(body.trim())) onCancel(); }
    catch (err) { setError((err as { message?: string })?.message || "Couldn't save your edit. Your text is still here."); }
    finally { saving.current = false; setBusy(false); }
  }
  return <><form className="space-y-2" aria-label="Edit comment" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label htmlFor={id} className="sr-only">Edit comment</label>
    <textarea id={id} value={body} rows={4} maxLength={REVIEW_LIMITS.COMMENT_MAX + 200}
      onChange={(event) => setBody(event.target.value)} onBlur={() => setTouched(true)}
      onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); } }}
      aria-invalid={touched && !!problem} aria-describedby={`${id}-help ${id}-window`}
      className="w-full resize-y rounded-lg border-2 border-line bg-bg px-3 py-2 text-body text-text placeholder:text-text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
    <div id={`${id}-help`} className="flex justify-between gap-2 text-micro"><span role={error || touched && problem ? "alert" : undefined} className={error || touched && problem ? "text-danger" : "text-text-dim"}>{error || touched && problem || `At least ${REVIEW_LIMITS.COMMENT_MIN} characters · ${shortcut} to save`}</span><span className={remaining < 0 ? "text-danger" : "text-text-dim"}>{remaining}</span></div>
    <p id={`${id}-window`} className={expired ? "text-caption text-warning" : "text-micro text-text-muted"} aria-live="polite">{expired ? "The 15-minute edit window has closed. Copy your text before cancelling." : remainingMs !== null ? `Editable for ${Math.ceil(remainingMs / 60_000)} more min` : null}</p>
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { if (body !== comment.body) setDiscard(true); else onCancel(); }}>Cancel</Button><Button type="submit" size="sm" loading={busy} disabled={busy || expired} aria-keyshortcuts="Control+Enter Meta+Enter">Save</Button></div>
  </form><ConfirmDialog open={discard} onClose={() => setDiscard(false)} onConfirm={onCancel} title="Discard this comment?" description="Your text will be removed from this browser." confirmLabel="Discard" cancelLabel="Keep editing" intent="danger" focusCancel /></>;
}

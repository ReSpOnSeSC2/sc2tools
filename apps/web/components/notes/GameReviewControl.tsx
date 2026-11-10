"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { CheckCircle2, ListTodo, Tags } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { gameReviewPath, REVIEW_TAG_PRESETS, REVIEW_TAGS_MAX, type GameReview, type ReviewState } from "@/lib/notes";
import { TagEditor } from "./TagEditor";

/**
 * The game header's review queue toggle: To review / Reviewed, plus up to
 * five review tags. Private to the owner; the Replays page filters on it.
 */
export function GameReviewControl({ gameId, review, onChanged }: {
  gameId: string;
  review?: GameReview | null;
  onChanged?: (review: GameReview | null) => void;
}) {
  const { getToken } = useAuth();
  const [current, setCurrent] = useState<GameReview | null>(review ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<string[]>(review?.tags ?? []);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  // The game row is the source of truth after every refresh.
  useEffect(() => { setCurrent(review ?? null); }, [review]);

  const state = current?.state ?? null;
  const put = async (next: { state: ReviewState | null; tags: string[] }) => {
    setBusy(true); setError("");
    try {
      const result = await apiCall<{ review: GameReview | null }>(getToken, gameReviewPath(gameId), { method: "PUT", body: JSON.stringify(next) });
      setCurrent(result.review);
      onChanged?.(result.review);
      return true;
    } catch (err) {
      setError((err as ClientApiError | undefined)?.message || "Couldn't update the review queue.");
      return false;
    } finally { setBusy(false); }
  };
  const currentTags = current?.tags ?? [];
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Review queue">
      <Button size="sm" variant={state === "todo" ? "primary" : "secondary"} aria-pressed={state === "todo"} disabled={busy}
        iconLeft={<ListTodo className="h-4 w-4" aria-hidden />} onClick={() => void put({ state: state === "todo" ? null : "todo", tags: currentTags })}>
        {state === "todo" ? "To review" : "Mark to review"}
      </Button>
      <Button size="sm" variant={state === "done" ? "primary" : "secondary"} aria-pressed={state === "done"} disabled={busy}
        iconLeft={<CheckCircle2 className="h-4 w-4" aria-hidden />} onClick={() => void put({ state: state === "done" ? null : "done", tags: currentTags })}>
        {state === "done" ? "Reviewed" : "Mark reviewed"}
      </Button>
      <Button ref={trigger} size="sm" variant="ghost" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
        iconLeft={<Tags className="h-4 w-4" aria-hidden />} onClick={() => { setTags(currentTags); setOpen(!open); }}>
        Review tags{currentTags.length ? ` (${currentTags.length})` : ""}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={trigger} id={panelId} label="Review tags" width={360} className="space-y-3">
        <TagEditor label="Review tags" tags={tags} onChange={setTags} max={REVIEW_TAGS_MAX} presets={REVIEW_TAG_PRESETS} disabled={busy} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={busy} onClick={async () => { if (await put({ state, tags })) { setOpen(false); trigger.current?.focus(); } }}>Save tags</Button>
          <Button size="sm" variant="ghost" onClick={() => { setOpen(false); trigger.current?.focus(); }}>Cancel</Button>
        </div>
        {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
      </Popover>
      {error && !open ? <span role="alert" className="text-caption text-danger">{error}</span> : null}
    </div>
  );
}

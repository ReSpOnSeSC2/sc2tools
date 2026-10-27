"use client";

import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { FocusRangeFields } from "./FocusRangeFields";
import { apiCall, useApi, useOwnerRequestScope } from "@/lib/clientApi";
import { gaEvent } from "@/lib/analytics/gtag";
import {
  DESIRED_LEVELS,
  REVIEW_LIMITS,
  REVIEW_TAGS,
  parseClock,
  reviewsRollout,
  reviewsVisible,
  validateQuestion,
  type DesiredLevel,
} from "@/lib/reviews";

type Props = {
  gameId: string;
  durationSec: number | null | undefined;
  matchup: string | null;
};

type ButtonProps = Props & {
  /**
   * The button's look, so it matches wherever it sits (the game header
   * pill by default; replay rows, dossier tables and the macro panel pass
   * their own action classes).
   */
  className?: string;
  /** Visible label; defaults to "Ask for a review". */
  label?: ReactNode;
  /** Accessible name when the visible label is shortened. */
  ariaLabel?: string;
  iconClassName?: string;
};

/**
 * "Ask for a review" for one of your games: the game page, your replay
 * list, an opponent dossier's replays and the macro breakdown. Only
 * offered while the rollout shows reviews to this viewer. The API
 * re-checks everything (own game, 1v1, macro breakdown, caps).
 */
export function AskForReviewButton({
  className,
  label = "Ask for a review",
  ariaLabel,
  iconClassName = "h-4 w-4",
  ...props
}: ButtonProps) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { data: me } = useApi<{ isAdmin?: boolean }>(
    isLoaded && isSignedIn && reviewsRollout() === "admins" ? "/v1/me" : null,
  );
  const [open, setOpen] = useState(false);
  // Keep the close action stable across updates to its host game row.
  const close = useCallback(() => setOpen(false), []);
  if (!isLoaded || !isSignedIn || !reviewsVisible(me?.isAdmin)) return null;
  const onClick = (e: MouseEvent) => {
    // Rows in some tables expand on click; asking shouldn't toggle them.
    e.stopPropagation();
    setOpen(true);
  };
  return (
    <>
      {className !== undefined ? <button type="button" onClick={onClick} aria-label={ariaLabel} title={ariaLabel} className={className}>
        <MessageSquarePlus className={iconClassName} aria-hidden /> {label}
      </button> : <Button variant="secondary" size="sm" onClick={onClick} aria-label={ariaLabel} title={ariaLabel} iconLeft={<MessageSquarePlus className={iconClassName} aria-hidden />}>{label}</Button>}
      {open ? (
        // The dialog is portalled, but React still bubbles its pointer
        // events through this spot in the tree — into clickable table rows.
        // Keyboard events are left alone: the Modal handles Esc/Tab on the
        // document.
        <span className="contents" {...STOP_POINTER_EVENTS}>
          <AskForReviewDialog key={userId} {...props} onClose={close} />
        </span>
      ) : null}
    </>
  );
}

const stopPropagation = (e: SyntheticEvent) => e.stopPropagation();

/** Handlers that keep a portalled dialog's pointer events inside it. */
export const STOP_POINTER_EVENTS = {
  onClick: stopPropagation,
  onDoubleClick: stopPropagation,
  onMouseDown: stopPropagation,
  onMouseUp: stopPropagation,
  onPointerDown: stopPropagation,
  onPointerUp: stopPropagation,
  onTouchStart: stopPropagation,
  onTouchEnd: stopPropagation,
} as const;

export function AskForReviewDialog(props: Props & { onClose: () => void }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const ownerId = isLoaded && isSignedIn && userId ? userId : null;
  // Hosts can reuse the same dialog while selecting a different replay. A
  // question and, especially, replay-sharing consent belong to one game.
  return ownerId ? <AskForReviewForm key={JSON.stringify([ownerId, props.gameId])} {...props} ownerId={ownerId} /> : null;
}

function AskForReviewForm({ gameId, durationSec, matchup, onClose, ownerId }: Props & { onClose: () => void; ownerId: string }) {
  const { getToken } = useAuth();
  const runOwned = useOwnerRequestScope(ownerId, getToken);
  const router = useRouter();
  const formId = useId();
  const [question, setQuestion] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [level, setLevel] = useState<DesiredLevel>("anyone");
  const [visibility, setVisibility] = useState<"public" | "link">("public");
  const [named, setNamed] = useState(false);
  const [shareReplay, setShareReplay] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState(false);
  const [discard, setDiscard] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const questionProblem = validateQuestion(question);
  const range = parseRange(rangeStart, rangeEnd, durationSec ?? null);
  const dirty = !!(question || tags.length || rangeStart || rangeEnd);
  const requestClose = () => {
    if (submitting.current) return;
    if (dirty) setDiscard(true); else onClose();
  };

  async function submit() {
    // The submit event can fire again before React disables the button (or
    // through Enter). Keep one mutation in flight for this dialog.
    if (submitting.current) return;
    setTouched(true);
    if (questionProblem || range.error) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    setExisting(false);
    try {
      const res = await runOwned(ownerId, (scopedToken, signal) => apiCall<{ id: string; url: string }>(scopedToken, "/v1/reviews", {
        method: "POST",
        signal,
        body: JSON.stringify({
          gameId,
          question: question.trim(),
          tags,
          timeRange: range.value,
          desiredLevel: level,
          visibility,
          askerDisplay: named ? "named" : "anonymous",
          shareReplay,
        }),
      }));
      // Closing the dialog or switching games must not let a late response
      // unexpectedly navigate away from the user's current screen.
      if (!mounted.current) return;
      gaEvent("review_requested", { matchup: matchup ?? "unknown", visibility, level });
      onClose();
      router.push(res.url);
    } catch (err) {
      if (!mounted.current) return;
      submitting.current = false;
      const e = err as { message?: string; code?: string };
      setError(e?.message || "Couldn't post your request.");
      setExisting(e?.code === "review_exists");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <><Modal
      open
      onClose={requestClose}
      disableScrimClose={dirty || busy}
      size="lg"
      title="Ask for a replay review"
      description="Reviewers answer with comments pinned to moments on your replay and the map. Your opponent is never named: they appear as their race and approximate MMR."
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={requestClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form={formId} loading={busy} disabled={busy}>Post request</Button>
        </div>
      }
    >
      <form id={formId} className="space-y-4" aria-busy={busy} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div>
          <label htmlFor={`${formId}-q`} className="text-caption font-semibold text-text">Your question</label>
          <textarea
            id={`${formId}-q`}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onBlur={() => setTouched(true)}
            rows={3}
            maxLength={REVIEW_LIMITS.QUESTION_MAX + 50}
            placeholder="Why did my blink all-in fail? I think I hit at 6:00 but the roaches were already out."
            className="mt-1 w-full rounded-lg border-2 border-line bg-bg px-3 py-2 text-body text-text placeholder:text-text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-invalid={touched && Boolean(questionProblem)}
            aria-describedby={`${formId}-q-help`}
          />
          <p id={`${formId}-q-help`} className={`mt-1 text-micro ${touched && questionProblem ? "text-danger" : "text-text-dim"}`}>
            {touched && questionProblem ? questionProblem : `${question.trim().length}/${REVIEW_LIMITS.QUESTION_MAX} · be specific about what you want reviewed`}
          </p>
        </div>

        <fieldset>
          <legend className="text-caption font-semibold text-text">Focus (optional)</legend>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {REVIEW_TAGS.map((t) => {
              const on = tags.includes(t.key);
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setTags((prev) => (on ? prev.filter((x) => x !== t.key) : [...prev, t.key]))}
                  className={`min-h-[36px] rounded-full border-2 px-3 text-caption font-semibold ${on ? "border-accent bg-accent/15 text-text" : "border-line text-text-muted hover:text-text"}`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <FocusRangeFields start={rangeStart} end={rangeEnd} onStartChange={setRangeStart} onEndChange={setRangeEnd} durationSec={durationSec ?? null} range={range} touched={touched} />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Who should review" hint="'My league or higher' is checked against each reviewer's league, verified from their own ranked games.">
            <Select value={level} onChange={(e) => setLevel(e.target.value as DesiredLevel)}>
              {DESIRED_LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
            </Select>
          </Field>
          <Field label="Visibility" hint="Link only: not listed on the board and not indexed by search engines. Anyone with the link can open it.">
            <Select value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "link")}>
              <option value="public">Public board</option>
              <option value="link">Link only (not listed)</option>
            </Select>
          </Field>
        </div>

        <label className="flex items-start gap-2 text-caption text-text">
          <input type="checkbox" checked={named} onChange={(e) => setNamed(e.target.checked)} className="mt-0.5 h-4 w-4" />
          <span>
            Show my display name (otherwise you appear as &ldquo;Anonymous {matchup ? raceName(matchup.charAt(0)) : "player"}&rdquo;).{" "}
            <span className="text-text-dim">Your display name is set in Settings.</span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-caption text-text">
          <input type="checkbox" checked={shareReplay} onChange={(e) => setShareReplay(e.target.checked)} className="mt-0.5 h-4 w-4" />
          <span>
            Let reviewers download the replay file.{" "}
            <span className="text-text-dim">Signed-in players can then open it in StarCraft II. You can stop sharing at any time, which stops new downloads.</span>
          </span>
        </label>
        {shareReplay ? (
          <p role="note" className="rounded-lg border border-warning/50 bg-warning/10 p-2 text-caption text-text">
            The .SC2Replay file contains both players&apos; in-game names and any in-game chat, including yours and your opponent&apos;s, even if you post anonymously.
            If the desktop agent hasn&apos;t backed up this replay yet, the download appears once it has.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg border border-danger/50 bg-danger/10 p-2 text-caption text-danger">
            {error}{" "}
            {existing ? <Link href="/reviews/mine" className="underline">See your requests</Link> : null}
          </p>
        ) : null}
      </form>
    </Modal><ConfirmDialog open={discard} onClose={() => setDiscard(false)} onConfirm={() => { if (!submitting.current) onClose(); }} intent="danger" focusCancel title="Discard this request?" description="Your question and selected focus will be removed." confirmLabel="Discard" cancelLabel="Keep editing" /></>
  );
}

function raceName(letter: string) {
  return letter === "P" ? "Protoss" : letter === "T" ? "Terran" : letter === "Z" ? "Zerg" : "player";
}

export function parseRange(startRaw: string, endRaw: string, durationSec: number | null): {
  value: { startSec: number; endSec: number } | null;
  error: string | null;
} {
  if (!startRaw.trim() && !endRaw.trim()) return { value: null, error: null };
  const start = parseClock(startRaw);
  const end = parseClock(endRaw);
  if (start === null || end === null) return { value: null, error: "Use m:ss for both times, e.g. 5:00 to 6:30." };
  if (end <= start) return { value: null, error: "The range must end after it starts." };
  if (start > 86_400 || end > 86_400) return { value: null, error: "Times must be within 24 hours." };
  if (durationSec !== null && end > durationSec + 1) return { value: null, error: "The range must sit inside the game." };
  return { value: { startSec: start, endSec: end }, error: null };
}

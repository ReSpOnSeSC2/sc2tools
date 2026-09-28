"use client";

import { useId, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { apiCall, useApi } from "@/lib/clientApi";
import { gaEvent } from "@/lib/analytics/gtag";
import {
  DESIRED_LEVELS,
  REVIEW_LIMITS,
  REVIEW_TAGS,
  formatClock,
  parseClock,
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

const DEFAULT_CLASS =
  "hard-press inline-flex h-9 items-center gap-1.5 rounded-full border-2 border-line bg-bg-surface px-3.5 font-display text-caption font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * "Ask for a review" for one of your games: the game page, your replay
 * list, an opponent dossier's replays and the macro breakdown. Only
 * offered while the rollout shows reviews to this viewer. The API
 * re-checks everything (own game, 1v1, macro breakdown, caps).
 */
export function AskForReviewButton({
  className = DEFAULT_CLASS,
  label = "Ask for a review",
  ariaLabel,
  iconClassName = "h-4 w-4",
  ...props
}: ButtonProps) {
  const { data: me } = useApi<{ isAdmin?: boolean }>("/v1/me");
  const [open, setOpen] = useState(false);
  if (!reviewsVisible(me?.isAdmin)) return null;
  const onClick = (e: MouseEvent) => {
    // Rows in some tables expand on click; asking shouldn't toggle them.
    e.stopPropagation();
    setOpen(true);
  };
  return (
    <>
      <button type="button" onClick={onClick} aria-label={ariaLabel} title={ariaLabel} className={className}>
        <MessageSquarePlus className={iconClassName} aria-hidden /> {label}
      </button>
      {open ? <AskForReviewDialog {...props} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function AskForReviewDialog({ gameId, durationSec, matchup, onClose }: Props & { onClose: () => void }) {
  const { getToken } = useAuth();
  const router = useRouter();
  const formId = useId();
  const [question, setQuestion] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [level, setLevel] = useState<DesiredLevel>("anyone");
  const [visibility, setVisibility] = useState<"public" | "link">("public");
  const [named, setNamed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);

  const questionProblem = validateQuestion(question);
  const range = parseRange(rangeStart, rangeEnd, durationSec ?? null);

  async function submit() {
    setTouched(true);
    if (questionProblem || range.error) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiCall<{ id: string; url: string }>(getToken, "/v1/reviews", {
        method: "POST",
        body: JSON.stringify({
          gameId,
          question: question.trim(),
          tags,
          timeRange: range.value,
          desiredLevel: level,
          visibility,
          askerDisplay: named ? "named" : "anonymous",
        }),
      });
      gaEvent("review_requested", { matchup: matchup ?? "unknown", visibility, level });
      router.push(res.url);
    } catch (err) {
      const e = err as { message?: string; code?: string };
      setError(e?.message || "Couldn't post your request.");
      if (e?.code === "review_exists") setExisting("existing");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Ask for a replay review"
      description="Reviewers answer with comments pinned to moments on your replay and the map. Your opponent is never named: they appear as their race and approximate MMR."
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} loading={busy} disabled={busy}>Post request</Button>
        </div>
      }
    >
      <form id={formId} className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
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

        <fieldset>
          <legend className="text-caption font-semibold text-text">Time range of interest (optional)</legend>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input aria-label="From (m:ss)" inputMode="numeric" placeholder="5:00" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} className="h-10 w-24 rounded-lg border-2 border-line bg-bg px-2 font-mono text-body" />
            <span className="text-text-dim">to</span>
            <input aria-label="To (m:ss)" inputMode="numeric" placeholder="6:30" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} className="h-10 w-24 rounded-lg border-2 border-line bg-bg px-2 font-mono text-body" />
            {durationSec ? <span className="text-micro text-text-dim">Game length {formatClock(durationSec)}</span> : null}
          </div>
          {touched && range.error ? <p className="mt-1 text-micro text-danger">{range.error}</p> : null}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-caption font-semibold text-text">
            Who should review
            <select value={level} onChange={(e) => setLevel(e.target.value as DesiredLevel)} className="h-10 rounded-lg border-2 border-line bg-bg px-2 text-body">
              {DESIRED_LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-caption font-semibold text-text">
            Visibility
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "link")} className="h-10 rounded-lg border-2 border-line bg-bg px-2 text-body">
              <option value="public">Public board</option>
              <option value="link">Link only (not listed)</option>
            </select>
          </label>
        </div>

        <label className="flex items-start gap-2 text-caption text-text">
          <input type="checkbox" checked={named} onChange={(e) => setNamed(e.target.checked)} className="mt-0.5 h-4 w-4" />
          <span>
            Show my display name (otherwise you appear as &ldquo;Anonymous {matchup ? raceName(matchup.charAt(0)) : "player"}&rdquo;).{" "}
            <span className="text-text-dim">Your display name is set in Settings.</span>
          </span>
        </label>

        {error ? (
          <p role="alert" className="rounded-lg border border-danger/50 bg-danger/10 p-2 text-caption text-danger">
            {error}{" "}
            {existing ? <Link href="/reviews" className="underline">See your requests</Link> : null}
          </p>
        ) : null}
      </form>
    </Modal>
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
  if (durationSec !== null && end > durationSec + 1) return { value: null, error: "The range must sit inside the game." };
  return { value: { startSec: start, endSec: end }, error: null };
}

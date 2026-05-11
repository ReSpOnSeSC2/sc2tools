"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";

/**
 * QuizCard — single-answer flow shell.
 *
 * Layout (mobile-first):
 *   ┌──────────── Header ─────────────┐
 *   │ [icon] Title          [pill: depth] │
 *   ├─────────────────────────────────┤
 *   │ Question prose (children: question)  │
 *   ├─────────────────────────────────┤
 *   │ Answer slot (children: answers)      │
 *   ├─────────────────────────────────┤
 *   │ Reveal slot (post-answer)           │
 *   └─────────────────────────────────┘
 *
 * The shell knows nothing about specific quizzes — it owns layout,
 * keyboard 1–4 routing, and the aria-live reveal region. Each mode
 * passes its question/answers/reveal as children. The reveal pane
 * animates in via CSS `data-revealed`; honors prefers-reduced-motion.
 */
export interface QuizCardProps {
  icon: React.ReactNode;
  title: string;
  depthLabel: string;
  question: React.ReactNode;
  answers: React.ReactNode;
  reveal?: React.ReactNode;
  revealed: boolean;
  /** When the user answers, called BEFORE reveal so engine can score. */
  onKeyAnswer?: (idx: number) => void;
  /** Render the share-card affordance when daily. */
  isDaily?: boolean;
  onShare?: () => void;
  onNext?: () => void;
}

export function QuizCard({
  icon,
  title,
  depthLabel,
  question,
  answers,
  reveal,
  revealed,
  onKeyAnswer,
  isDaily,
  onShare,
  onNext,
}: QuizCardProps) {
  // 1–4 keys pick the corresponding answer when the question is open.
  useEffect(() => {
    if (revealed || !onKeyAnswer) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key;
      if (key === "1" || key === "2" || key === "3" || key === "4") {
        onKeyAnswer(Number(key) - 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [revealed, onKeyAnswer]);

  return (
    <Card variant="elevated" padded={false} className="overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-bg-elevated px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-bg-surface text-accent-cyan">
            {icon}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-body font-semibold text-text">{title}</h3>
            <p className="text-caption text-text-dim">{depthLabel}</p>
          </div>
        </div>
        {isDaily ? (
          <span className="rounded-full bg-accent/15 px-2 py-0.5 text-caption font-semibold uppercase tracking-wider text-accent">
            Daily
          </span>
        ) : null}
      </header>

      <div className="space-y-4 p-4">
        <div className="text-body text-text">{question}</div>
        <div className="space-y-2">{answers}</div>

        {reveal ? (
          <div
            role="region"
            aria-live="polite"
            data-revealed={revealed ? "true" : "false"}
            className={[
              "rounded-lg border border-border bg-bg-elevated p-3 transition-opacity duration-150",
              "motion-reduce:transition-none",
              revealed ? "opacity-100" : "pointer-events-none opacity-0",
            ].join(" ")}
            style={{ minHeight: revealed ? undefined : 0 }}
          >
            {revealed ? reveal : null}
          </div>
        ) : null}

        {revealed ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {onShare ? (
              <button
                type="button"
                onClick={onShare}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-bg-surface px-3 text-caption font-semibold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Share
              </button>
            ) : null}
            {onNext ? (
              <button
                type="button"
                onClick={onNext}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-accent px-4 text-caption font-semibold uppercase tracking-wider text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Next round →
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * QuizAnswerButton — keyboard-and-touch friendly answer slot. Renders
 * a number badge so the 1–4 keyboard shortcut is discoverable.
 */
export function QuizAnswerButton({
  index,
  selected,
  correct,
  onClick,
  children,
  disabled,
}: {
  index: number;
  selected?: boolean;
  correct?: boolean | null;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const tone =
    correct === true
      ? "border-success/50 bg-success/10 text-text"
      : correct === false
        ? "border-danger/50 bg-danger/10 text-text"
        : selected
          ? "border-accent bg-accent/10 text-text"
          : "border-border bg-bg-surface text-text hover:border-border-strong hover:bg-bg-elevated";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected ? "true" : "false"}
      className={[
        "flex w-full min-h-[44px] items-center gap-3 rounded-lg border px-3 py-2 text-left text-body transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:cursor-not-allowed disabled:opacity-60",
        tone,
      ].join(" ")}
    >
      <KeyBadge n={index + 1} />
      <span className="flex-1 min-w-0">{children}</span>
    </button>
  );
}

export function KeyBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border border-border bg-bg-elevated text-caption font-mono text-text-muted"
    >
      {n}
    </span>
  );
}

/* Useful for quizzes that want to render a "selected → correct" affordance. */
export function useSingleSelect<A>() {
  const [picked, setPicked] = useState<A | null>(null);
  return { picked, setPicked };
}

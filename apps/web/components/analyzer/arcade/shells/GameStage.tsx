"use client";

import { Card } from "@/components/ui/Card";

/**
 * GameStage — multi-turn flow shell with persistent HUD (score / lives /
 * timer / hint).
 *
 * Distinguished from QuizCard: the HUD persists across turns, the
 * primary action is sticky in the thumb zone on mobile, and the result
 * reveal is inline-per-turn rather than a single reveal pane.
 */
export interface GameStageProps {
  icon: React.ReactNode;
  title: string;
  depthLabel: string;
  hud: GameHud;
  body: React.ReactNode;
  /** Optional sticky footer / primary CTA for the current turn. */
  primary?: React.ReactNode;
  isDaily?: boolean;
  onShare?: () => void;
}

export interface GameHud {
  score?: number | string;
  lives?: number;
  timerSec?: number | null;
  hint?: string;
}

export function GameStage({
  icon,
  title,
  depthLabel,
  hud,
  body,
  primary,
  isDaily,
  onShare,
}: GameStageProps) {
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

      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-bg-surface px-4 py-2 text-caption">
        {typeof hud.score !== "undefined" ? (
          <HudPill label="Score" value={String(hud.score)} />
        ) : null}
        {typeof hud.lives === "number" ? (
          <HudPill label="Lives" value={"♥".repeat(Math.max(0, hud.lives)) || "—"} tone="warn" />
        ) : null}
        {hud.timerSec !== undefined && hud.timerSec !== null ? (
          <HudPill
            label="Time"
            value={`${Math.max(0, hud.timerSec).toFixed(0)}s`}
            tone={hud.timerSec < 5 ? "danger" : "default"}
          />
        ) : null}
        {hud.hint ? (
          <span className="ml-auto text-caption text-text-dim">{hud.hint}</span>
        ) : null}
      </div>

      <div className="space-y-4 p-4">{body}</div>

      {primary || onShare ? (
        <footer className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg-elevated/95 px-4 py-3 backdrop-blur">
          {onShare ? (
            <button
              type="button"
              onClick={onShare}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-bg-surface px-3 text-caption font-semibold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Share
            </button>
          ) : null}
          {primary}
        </footer>
      ) : null}
    </Card>
  );
}

function HudPill({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warn" | "danger";
}) {
  const colors =
    tone === "warn"
      ? "text-warning"
      : tone === "danger"
        ? "text-danger"
        : "text-text";
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-caption uppercase tracking-wider text-text-dim">
        {label}
      </span>
      <span className={["font-mono tabular-nums font-semibold", colors].join(" ")}>
        {value}
      </span>
    </span>
  );
}

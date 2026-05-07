"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useAuth } from "@clerk/nextjs";
import { AlertCircle, RefreshCcw, X } from "lucide-react";
import { useApi, apiCall } from "@/lib/clientApi";
import { fmtDate } from "@/lib/format";
import {
  computeEffectiveRace,
  computePenaltyRows,
  computeWins,
  getRaceDetail,
  isMissingChartSamples,
  scoreToneTextClass,
  selectLeaks,
} from "@/lib/macro";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { ActiveArmyChart } from "./ActiveArmyChart";
import { MacroLeaksList } from "./MacroLeaksList";
import { MacroPenaltyBars } from "./MacroPenaltyBars";
import { SpendingQuotientStat } from "./SpendingQuotientStat";
import type {
  LeakItem,
  MacroBreakdownData,
  MacroBreakdownPanelProps,
  PanelHeaderMeta,
} from "./MacroBreakdownPanel.types";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * MacroBreakdownPanel — slide-in sheet that drills into a single game's
 * macro score. Fetches the breakdown lazily (only while open), exposes
 * a Recompute action that requests an agent re-parse, and threads
 * highlight state from the leaks list into the chart marker layer.
 *
 * Sheet behavior: bottom-anchored full-screen ≤640px, right-anchored
 * (max-w-3xl) ≥640px. Esc closes; focus traps inside; body scrolls
 * locked while open; previous focus is restored on close.
 */
export function MacroBreakdownPanel({
  open,
  onClose,
  gameId,
  initialScore,
  headerMeta,
}: MacroBreakdownPanelProps) {
  const { getToken } = useAuth();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);

  const { data, error, isLoading, mutate } = useApi<MacroBreakdownData>(
    open ? `/v1/games/${encodeURIComponent(gameId)}/macro-breakdown` : null,
    { revalidateOnFocus: false },
  );

  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setRecomputeMsg(null);
      setRecomputing(false);
      setHighlightedKey(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        trapTab(e, dialogRef.current);
      }
    };
    document.addEventListener("keydown", onKey);

    const initFocus = window.setTimeout(() => {
      const els = focusableInside(dialogRef.current);
      (els[0] ?? dialogRef.current)?.focus();
    }, 0);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(initFocus);
      const prev = previouslyFocusedRef.current as HTMLElement | null;
      prev?.focus?.();
    };
  }, [open, onClose]);

  const recompute = useCallback(async () => {
    if (recomputing) return;
    setRecomputeMsg(null);
    setRecomputing(true);
    try {
      await apiCall<{ ok: boolean }>(
        getToken,
        `/v1/games/${encodeURIComponent(gameId)}/macro-breakdown`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setRecomputeMsg(
        "Recompute requested. If your desktop agent is online and listening, it'll re-upload shortly. If nothing changes after a minute, open the agent app and click Resync.",
      );
      mutate();
    } catch (err) {
      const e = err as { message?: string };
      setRecomputeMsg(e.message || "Recompute failed.");
    } finally {
      setRecomputing(false);
    }
  }, [getToken, gameId, mutate, recomputing]);

  if (!open) return null;
  if (typeof window === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-stretch overflow-hidden"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close macro breakdown"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-full w-full max-h-[100dvh] flex-col bg-bg-surface text-text shadow-[var(--shadow-card)] sm:m-4 sm:rounded-xl sm:border sm:border-border sm:max-h-[calc(100dvh-2rem)] md:m-6 md:max-h-[calc(100dvh-3rem)]"
      >
        <PanelHeader
          titleId={titleId}
          gameId={gameId}
          meta={headerMeta}
          onClose={onClose}
        />
        <div className="flex-1 overflow-y-auto px-4 py-5 pb-[env(safe-area-inset-bottom,0px)] sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            {isLoading ? (
              <LoadingState />
            ) : error ? (
              <ErrorState
                status={error.status}
                message={error.message}
                recomputing={recomputing}
                onRecompute={recompute}
              />
            ) : !data ? null : (
              <BreakdownBody
                data={data}
                initialScore={initialScore}
                highlightedKey={highlightedKey}
                onHighlight={setHighlightedKey}
              />
            )}
          </div>
        </div>
        <PanelFooter
          recomputing={recomputing}
          recomputeMsg={recomputeMsg}
          onRecompute={recompute}
          onClose={onClose}
        />
      </div>
    </div>,
    document.body,
  );
}

/* ============================================================
 * Header + Footer
 * ============================================================ */

function PanelHeader({
  titleId,
  gameId,
  meta,
  onClose,
}: {
  titleId: string;
  gameId: string;
  meta?: PanelHeaderMeta;
  onClose: () => void;
}) {
  const playerName = meta?.playerName?.trim() || "You";
  const opponent = meta?.opponentName?.trim();
  const myRaceLetter = (meta?.myRace || "").charAt(0).toUpperCase();
  const oppRaceLetter = (meta?.opponentRace || "").charAt(0).toUpperCase();
  const dateLine = formatHeaderDate(meta?.dateIso);
  return (
    <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-bg-elevated/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-bg-elevated/85 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-caption font-semibold uppercase tracking-wider text-accent-cyan">
            Macro breakdown
          </div>
          <h2
            id={titleId}
            className="flex flex-wrap items-center gap-2 text-h3 font-semibold text-text sm:text-h2"
          >
            {myRaceLetter ? (
              <Icon
                name={myRaceLetter}
                kind="race"
                size="sm"
                fallback={myRaceLetter}
                decorative
              />
            ) : null}
            <span>{playerName}</span>
            {opponent ? (
              <>
                <span className="text-text-dim">vs</span>
                {oppRaceLetter ? (
                  <Icon
                    name={oppRaceLetter}
                    kind="race"
                    size="sm"
                    fallback={oppRaceLetter}
                    decorative
                  />
                ) : null}
                <span className="truncate">{opponent}</span>
              </>
            ) : null}
          </h2>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-text-muted">
            {dateLine ? <span>{dateLine}</span> : null}
            {meta?.map ? (
              <>
                {dateLine ? <span aria-hidden>·</span> : null}
                <span>{meta.map}</span>
              </>
            ) : null}
            {meta?.result ? (
              <>
                <span aria-hidden>·</span>
                <span>{meta.result}</span>
              </>
            ) : null}
            <span className="hidden font-mono text-[11px] text-text-dim sm:ml-auto sm:inline">
              {gameId}
            </span>
          </p>
        </div>
        <button
          type="button"
          aria-label="Close macro breakdown"
          onClick={onClose}
          className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
    </header>
  );
}

function PanelFooter({
  recomputing,
  recomputeMsg,
  onRecompute,
  onClose,
}: {
  recomputing: boolean;
  recomputeMsg: string | null;
  onRecompute: () => void;
  onClose: () => void;
}) {
  return (
    <footer className="sticky bottom-0 z-10 border-t border-border bg-bg-elevated/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-bg-elevated/85 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-end gap-2">
        {recomputeMsg ? (
          <span
            className="mr-auto max-w-full text-caption text-text-muted sm:max-w-[60%]"
            role="status"
          >
            {recomputeMsg}
          </span>
        ) : null}
        <Button
          variant="secondary"
          onClick={onRecompute}
          loading={recomputing}
          disabled={recomputing}
          iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}
        >
          {recomputing ? "Recomputing…" : "Recompute"}
        </Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </footer>
  );
}

/* ============================================================
 * Body
 * ============================================================ */

function BreakdownBody({
  data,
  initialScore,
  highlightedKey,
  onHighlight,
}: {
  data: MacroBreakdownData;
  initialScore?: number | null;
  highlightedKey: string | null;
  onHighlight: (key: string | null, leak: LeakItem | null) => void;
}) {
  const score =
    typeof data.macro_score === "number"
      ? data.macro_score
      : (initialScore ?? null);
  const raw = data.raw || {};
  const effectiveRace = computeEffectiveRace(data.race, raw);
  const detail = getRaceDetail(effectiveRace);
  const leaks = useMemo(() => selectLeaks(data), [data]);
  const wins = useMemo(() => computeWins(raw, detail), [raw, detail]);
  const penaltyRows = useMemo(
    () => computePenaltyRows(raw, detail),
    [raw, detail],
  );
  const headlineColour = scoreToneTextClass(score);
  const samplesMissing = isMissingChartSamples(data);

  return (
    <div className="space-y-5 sm:space-y-6">
      <Headline score={score} colourClass={headlineColour} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SpendingQuotientStat
          label="Spending Quotient"
          value={typeof raw.sq === "number" ? raw.sq : null}
          tone="cyan"
          glow
          decimals={1}
          explanation="SQ blends income and unspent resources into a single ladder-tier metric. 80+ is Master/Pro pacing; 70+ is solid Diamond."
        />
        <SpendingQuotientStat
          label="Supply blocked"
          value={raw.supply_blocked_seconds}
          tone={(raw.supply_blocked_seconds || 0) > 10 ? "warning" : "neutral"}
          unit="s"
          hint="Lower is better"
          explanation="Total seconds your supply was capped — production stalls during these windows, costing units and tempo."
        />
        <SpendingQuotientStat
          label="Float spikes"
          value={raw.mineral_float_spikes}
          tone={(raw.mineral_float_spikes || 0) > 0 ? "warning" : "neutral"}
          hint="Samples > 800 minerals after 4:00"
          explanation="How many mid-game samples showed a sustained mineral surplus. Banked minerals that aren't building units delay your next push."
        />
      </div>

      <section
        aria-labelledby="penalty-heading"
        className="space-y-3 rounded-lg border border-border bg-bg-elevated/40 p-4"
      >
        <h3
          id="penalty-heading"
          className="text-caption font-semibold uppercase tracking-wider text-text-muted"
        >
          Where the score went
        </h3>
        <MacroPenaltyBars
          rows={penaltyRows}
          caption="Each bar shows how much that discipline shaved off the headline. Empty bars mean the penalty was zero."
        />
        {detail &&
        raw[detail.actualKey] != null &&
        raw[detail.expectedKey] != null ? (
          <RaceDisciplineCallout
            title={detail.title}
            actual={Number(raw[detail.actualKey] || 0)}
            expected={Number(raw[detail.expectedKey] || 0)}
            unitPlural={detail.unitPlural}
          />
        ) : null}
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section
          aria-labelledby="leaks-heading"
          className="space-y-2 rounded-lg border border-border bg-bg-elevated/40 p-4"
        >
          <h3
            id="leaks-heading"
            className="text-caption font-semibold uppercase tracking-wider text-danger"
          >
            Where you lost economy
          </h3>
          <MacroLeaksList
            leaks={leaks}
            highlightedKey={highlightedKey}
            onSelect={onHighlight}
          />
        </section>

        {wins.length > 0 ? (
          <section
            aria-labelledby="wins-heading"
            className="space-y-2 rounded-lg border border-border bg-bg-elevated/40 p-4"
          >
            <h3
              id="wins-heading"
              className="text-caption font-semibold uppercase tracking-wider text-success"
            >
              What you did well
            </h3>
            <ul className="list-disc space-y-1 pl-5 text-caption text-text">
              {wins.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <section
        aria-labelledby="chart-heading"
        className="space-y-2 rounded-lg border border-border bg-bg-elevated/40 p-4"
      >
        <h3
          id="chart-heading"
          className="text-caption font-semibold uppercase tracking-wider text-text-muted"
        >
          Active Army &amp; Workers
        </h3>
        {samplesMissing ? (
          <ChartSamplesMissingHint />
        ) : (
          <ActiveArmyChart
            samples={data.stats_events || []}
            oppSamples={data.opp_stats_events || []}
            gameLengthSec={data.game_length_sec}
            leaks={leaks}
            highlightedKey={highlightedKey}
          />
        )}
      </section>
    </div>
  );
}

function Headline({
  score,
  colourClass,
}: {
  score: number | null;
  colourClass: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-3">
      <span className="text-caption uppercase tracking-wider text-text-dim">
        Macro Score
      </span>
      <span
        className={`text-display-lg font-bold tabular-nums ${colourClass}`}
        aria-label={
          typeof score === "number"
            ? `Score ${score} of 100`
            : "Score not computed"
        }
      >
        {typeof score === "number" ? score : "—"}
        <span className="ml-1 text-body-lg font-normal text-text-dim">
          / 100
        </span>
      </span>
    </div>
  );
}

function RaceDisciplineCallout({
  title,
  actual,
  expected,
  unitPlural,
}: {
  title: string;
  actual: number;
  expected: number;
  unitPlural: string;
}) {
  const pct = Math.round((100 * actual) / Math.max(1, expected));
  return (
    <div className="rounded-md bg-bg-subtle p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-dim">
        {title}
      </div>
      <div className="mt-1 text-caption text-accent">
        {actual} of ~{expected} expected ({pct}% {unitPlural})
      </div>
    </div>
  );
}

function ChartSamplesMissingHint() {
  return (
    <div className="rounded-md border border-border bg-bg-subtle p-3 text-caption text-text-muted">
      <div className="inline-flex items-center gap-2 font-semibold text-accent-cyan">
        <AlertCircle className="h-4 w-4" aria-hidden />
        Per-second samples not available
      </div>
      <p className="mt-1">
        This game's stored breakdown is the slim variant — the time-series
        chart needs the full sample stream from your SC2 agent. Click
        Recompute to ask the agent to re-parse the replay.
      </p>
    </div>
  );
}

/* ============================================================
 * Loading / error / fallback states
 * ============================================================ */

function LoadingState() {
  return (
    <div className="space-y-4">
      <div className="h-10 w-40 animate-pulse rounded-md bg-bg-elevated" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <div className="h-32 animate-pulse rounded-lg bg-bg-elevated" />
    </div>
  );
}

function SkeletonCard() {
  return <div className="h-24 animate-pulse rounded-lg bg-bg-elevated" />;
}

function ErrorState({
  status,
  message,
  recomputing,
  onRecompute,
}: {
  status: number;
  message: string;
  recomputing: boolean;
  onRecompute: () => void;
}) {
  if (status === 404) {
    return (
      <EmptyDataPanel
        title="Macro breakdown not available for this game yet"
        body={
          <>
            Your SC2 agent hasn&apos;t uploaded a breakdown for this replay.
            The reliable fix is to{" "}
            <span className="font-semibold text-text">
              open the agent app and click Resync
            </span>{" "}
            — it re-uploads every replay, breakdowns included. Recompute
            below pings the agent for just this game; it only works if your
            agent version listens for per-game requests.
          </>
        }
        onRecompute={onRecompute}
        recomputing={recomputing}
      />
    );
  }
  return (
    <div className="rounded-lg border border-danger/40 bg-bg-elevated/40 p-4 text-caption text-danger">
      Macro unavailable: {message}
    </div>
  );
}

function EmptyDataPanel({
  title,
  body,
  onRecompute,
  recomputing,
}: {
  title: string;
  body: ReactNode;
  onRecompute: () => void;
  recomputing: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-elevated/40 p-5">
      <div className="inline-flex items-center gap-2 text-caption font-semibold text-accent-cyan">
        <AlertCircle className="h-4 w-4" aria-hidden />
        {title}
      </div>
      <p className="mt-2 text-caption text-text-muted">{body}</p>
      <div className="mt-3">
        <Button
          variant="secondary"
          size="sm"
          loading={recomputing}
          onClick={onRecompute}
          iconLeft={<RefreshCcw className="h-3.5 w-3.5" aria-hidden />}
        >
          {recomputing ? "Recomputing…" : "Recompute now"}
        </Button>
      </div>
    </div>
  );
}

function formatHeaderDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const formatted = fmtDate(iso);
  return formatted === "—" ? "" : formatted;
}

/* ============================================================
 * Focus-trap helpers
 * ============================================================ */

function focusableInside(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function trapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const els = focusableInside(root);
  if (els.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = els[0];
  const last = els[els.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !root.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last) {
    e.preventDefault();
    first.focus();
  }
}


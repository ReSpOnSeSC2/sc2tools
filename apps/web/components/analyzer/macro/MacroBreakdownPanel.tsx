"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, RefreshCcw, X } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { useMapReplay } from "@/lib/useMapReplay";
import { fmtDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { AskForReviewButton } from "@/components/reviews/AskForReviewButton";
import { matchupFromRaces } from "@/lib/reviews";
import { lockBodyScroll } from "@/lib/bodyScrollLock";
import Link from "next/link";
import { MacroBreakdownBody } from "./MacroBreakdownBody";
import { MacroBuildSelector } from "./MacroBuildSelector";
import { useMacroRecompute } from "./useMacroRecompute";
import type {
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
 * MacroBreakdownPanel — drilldown surface for a single game's macro
 * score. On mobile it renders as a full-bleed page that takes over the
 * viewport (matching the look of the Strategies dossier), with the
 * match timeline pinned under the header while the roster scrolls; on
 * ≥640px it becomes a wide centered modal with margin + rounded corners.
 *
 * Esc closes; focus traps inside; body scrolls locked while open;
 * previous focus is restored on close.
 */
export function MacroBreakdownPanel({
  open,
  onClose,
  gameId,
  initialScore,
  headerMeta,
  reviewable = false,
}: MacroBreakdownPanelProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const { data, error, isLoading, mutate, recompute, recomputing, recomputeMsg } = useMacroRecompute(open ? gameId : null);
  // Recording stays a separate consented action from routine replay analysis.
  const replayController = useMapReplay(open ? gameId : null);
  const completedRequest = useRef<string | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setHighlightedKey(null);
    }
  }, [open]);

  useEffect(() => {
    const requestId = replayController.completedRequestId;
    if (!open || !requestId || completedRequest.current === requestId) return;
    completedRequest.current = requestId;
    void mutate().catch(() => undefined);
  }, [open, replayController.completedRequestId, mutate]);

  useEffect(() => {
    // The chart pins directly under the sticky header on phones; publish
    // the header's live height (it wraps with long names) for its offset.
    const header = headerRef.current;
    const dialog = dialogRef.current;
    if (!open || !header || !dialog || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      dialog.style.setProperty("--macro-header-h", `${header.offsetHeight}px`);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement;
    const unlockScroll = lockBodyScroll();

    const onKey = (e: KeyboardEvent) => {
      // A dialog layered on top of the panel (e.g. "Ask for a review")
      // owns the keyboard while focus is inside it: don't close the panel
      // on its Esc or pull its Tab focus back here.
      const target = e.target instanceof Element ? e.target : document.activeElement;
      const layered = target?.closest('[role="dialog"]');
      if (layered && layered !== dialogRef.current) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
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
      unlockScroll();
      window.clearTimeout(initFocus);
      const prev = previouslyFocusedRef.current as HTMLElement | null;
      if (prev?.isConnected) prev.focus();
    };
  }, [open]);

  if (!open) return null;
  if (typeof window === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 overflow-x-hidden overflow-y-auto bg-bg sm:bg-black/70 sm:backdrop-blur-sm sm:p-4 md:p-6"
      role="presentation"
      data-testid="macro-breakdown-portal"
      onClick={(e) => {
        // Backdrop click closes only on >=sm — on mobile the surface is
        // edge-to-edge with no backdrop to click.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative mx-auto flex min-h-[100dvh] w-full min-w-0 max-w-[1440px] flex-col bg-bg-surface text-text sm:min-h-0 sm:rounded-xl sm:border sm:border-border sm:shadow-[var(--shadow-card)]"
      >
        <PanelHeader
          headerRef={headerRef}
          titleId={titleId}
          gameId={gameId}
          meta={headerMeta}
          action={reviewable ? (
            <AskForReviewButton
              gameId={gameId}
              durationSec={data?.game_length_sec ?? null}
              matchup={matchupFromRaces(headerMeta?.myRace, headerMeta?.opponentRace)}
              className="inline-flex h-10 flex-shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg-surface px-3 text-caption font-semibold text-text transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              label={<span className="hidden sm:inline">Ask for a review</span>}
              ariaLabel="Ask for a review of this game"
            />
          ) : null}
          onClose={onClose}
        />
        <div className="min-w-0 flex-1 space-y-4 px-4 pb-6 pt-3 sm:px-6 sm:py-5 lg:px-8">
          <MacroBuildSelector gameId={gameId} />
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
            <MacroBreakdownBody
              data={data}
              gameId={gameId}
              initialScore={initialScore}
              highlightedKey={highlightedKey}
              onHighlight={setHighlightedKey}
              headerMeta={headerMeta}
              replayController={replayController}
              onRecompute={recompute}
              recomputing={recomputing}
            />
          )}
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
  headerRef,
  titleId,
  gameId,
  meta,
  action,
  onClose,
}: {
  headerRef: RefObject<HTMLElement | null>;
  titleId: string;
  gameId: string;
  meta?: PanelHeaderMeta;
  /** Optional header action beside Close (e.g. "Ask for a review"). */
  action?: ReactNode;
  onClose: () => void;
}) {
  const playerName = meta?.playerName?.trim() || "You";
  const opponent = meta?.opponentName?.trim();
  const myRaceLetter = (meta?.myRace || "").charAt(0).toUpperCase();
  const oppRaceLetter = (meta?.opponentRace || "").charAt(0).toUpperCase();
  const dateLine = formatHeaderDate(meta?.dateIso);
  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-bg-elevated/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-bg-elevated/85 sm:rounded-t-xl sm:px-6 sm:py-3 lg:px-8"
    >
      <div className="mx-auto flex w-full max-w-[1440px] items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5 sm:space-y-1">
          <div className="text-micro font-semibold uppercase tracking-wider text-accent-cyan sm:text-caption">
            Macro breakdown
          </div>
          <h2
            id={titleId}
            className="flex flex-wrap items-center gap-2 text-h4 font-semibold text-text sm:text-h2"
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
            <span className="hidden font-mono text-micro text-text-dim sm:ml-auto sm:inline">
              {gameId}
            </span>
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <Link href={`/app/game/${encodeURIComponent(gameId)}#macro`} onClick={onClose} className="inline-flex min-h-11 items-center text-caption font-semibold text-accent hover:underline">Open full game page →</Link>
          {action}
          <button
            type="button"
            aria-label="Close macro breakdown"
            onClick={onClose}
            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
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
    <footer
      className={[
        // In flow at the end of the panel on every screen. On phones the
        // top of the screen holds the pinned chart, so a fixed action
        // bar would squeeze the scrolling half; Close stays in the header.
        "border-t border-border bg-bg-elevated px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        "sm:rounded-b-xl sm:pb-3 sm:px-6 lg:px-8",
      ].join(" ")}
    >
      <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center justify-end gap-2">
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
          {recomputing ? "Requesting…" : "Recompute"}
        </Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </footer>
  );
}

/* ============================================================
 * Body
 * ============================================================ */

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


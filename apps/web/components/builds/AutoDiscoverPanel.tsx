"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import type { ClientApiError } from "@/lib/clientApi";
import {
  applyAutoCandidates,
  useAutoCandidates,
} from "@/lib/autoClassifyApi";
import { AutoCandidateCard } from "./AutoCandidateCard";
import type { AutoApplyResult, AutoCandidate, BuildPerspective } from "./types";

export interface AutoDiscoverPanelProps {
  /**
   * Called after the user successfully applies one or more candidates,
   * so the parent can re-mutate its builds + stats SWR caches and the
   * new builds appear in the grid.
   */
  onApplied?: (createdSlugs: string[]) => Promise<void> | void;
}

const SESSION_STORAGE_KEY = "autoDiscover.dismissed";

/**
 * AutoDiscoverPanel — collapsible discovery panel above the build grid.
 *
 * Loads candidates from GET /v1/auto-classify/candidates and renders one
 * AutoCandidateCard per group. The user can:
 *   - Toggle perspective (You / Opponent)
 *   - Hit "Scan now" to re-mutate the SWR cache
 *   - Edit each candidate's proposed name inline before creating
 *   - Promote a candidate to a real custom build via POST /apply
 *   - Dismiss a candidate locally (kept in sessionStorage; not server-side)
 *
 * Responsive: header wraps on narrow widths, cards stack single-column
 * under sm, and a primary-action "Create build" is always reachable
 * without hover. No fixed widths force horizontal scroll at 360px.
 */
export function AutoDiscoverPanel({ onApplied }: AutoDiscoverPanelProps) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const [perspective, setPerspective] = useState<BuildPerspective>("you");
  const [open, setOpen] = useState(true);
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    loadDismissed(),
  );
  // Cards that are currently mid-apply — we hide them immediately for
  // an instant feel, then either let the SWR refresh drop them for
  // real (success) or restore them (failure rollback). NOT persisted to
  // sessionStorage: optimistic state is transient and must reset on reload.
  const [optimisticallyHidden, setOptimisticallyHidden] = useState<Set<string>>(
    () => new Set(),
  );
  const [creatingKey, setCreatingKey] = useState<string | null>(null);
  const [creatingAll, setCreatingAll] = useState(false);
  // Guard against double-submit even within the same render — the
  // setState flips above happen on the next paint, so a rapid second
  // click can fire before the disabled prop reaches the DOM.
  const inFlightRef = useRef(false);

  const swr = useAutoCandidates(perspective);

  const visible = useMemo<AutoCandidate[]>(
    () =>
      (swr.candidates || []).filter((c) => {
        const key = dismissKey(c);
        return !dismissed.has(key) && !optimisticallyHidden.has(key);
      }),
    [swr.candidates, dismissed, optimisticallyHidden],
  );

  const dismissCandidate = useCallback(
    (c: AutoCandidate) => {
      setDismissed((prev) => {
        const next = new Set(prev);
        next.add(dismissKey(c));
        persistDismissed(next);
        return next;
      });
    },
    [],
  );

  const clearDismissed = useCallback(() => {
    setDismissed(new Set());
    persistDismissed(new Set());
  }, []);

  const hideOptimistically = useCallback((keys: string[]) => {
    setOptimisticallyHidden((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
  }, []);

  const restoreOptimistically = useCallback((keys: string[]) => {
    setOptimisticallyHidden((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
  }, []);

  const handleScan = useCallback(async () => {
    try {
      await swr.mutate();
    } catch (err) {
      toast.error("Couldn’t refresh discovery", {
        description: extractErr(err),
      });
    }
  }, [swr, toast]);

  const handleCreate = useCallback(
    async (c: AutoCandidate, editedName: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const key = dismissKey(c);
      setCreatingKey(key);
      hideOptimistically([key]);
      let committed = false;
      try {
        const payload: AutoCandidate = { ...c, proposedName: editedName };
        const res = await applyAutoCandidates(getToken, [payload]);
        committed = true;
        toast.success(formatCreatedToastTitle(editedName, res.tagged));
        if (onApplied) await onApplied(res.created);
        // Re-fetch the discovery list — the server has already
        // dropped this candidate, so the optimistic hide naturally
        // becomes the new truth. Leaving the key in the set is fine:
        // it can never match a real candidate again.
        await swr.mutate();
      } catch (err) {
        // Only roll back the optimistic hide when the server-side
        // apply itself failed. If we get here AFTER ``committed``
        // flips, the new build is already persisted — surfacing a
        // rollback would lie to the user.
        if (!committed) {
          restoreOptimistically([key]);
          toast.error("Couldn’t create build", {
            description: extractErrDetailed(err),
          });
        }
      } finally {
        setCreatingKey(null);
        inFlightRef.current = false;
      }
    },
    [getToken, hideOptimistically, onApplied, restoreOptimistically, swr, toast],
  );

  const handleCreateAll = useCallback(async () => {
    if (inFlightRef.current || visible.length === 0) return;
    inFlightRef.current = true;
    const snapshot = visible.slice();
    const keys = snapshot.map(dismissKey);
    setCreatingAll(true);
    hideOptimistically(keys);
    let committed = false;
    try {
      const res: AutoApplyResult = await applyAutoCandidates(
        getToken,
        snapshot,
      );
      committed = true;
      toast.success(formatCreatedAllToastTitle(res.created.length, res.tagged));
      if (onApplied) await onApplied(res.created);
      await swr.mutate();
    } catch (err) {
      if (!committed) {
        restoreOptimistically(keys);
        toast.error("Couldn’t create builds", {
          description: extractErrDetailed(err),
        });
      }
    } finally {
      setCreatingAll(false);
      inFlightRef.current = false;
    }
  }, [
    getToken,
    hideOptimistically,
    onApplied,
    restoreOptimistically,
    swr,
    toast,
    visible,
  ]);

  const isLoading = swr.isLoading && !swr.data;
  const errorMessage = swr.error?.message;
  const totalRaw = swr.candidates?.length ?? 0;
  const hiddenCount = totalRaw - visible.length;
  const canCreateAll =
    !isLoading && !errorMessage && visible.length > 0 && !creatingKey;

  return (
    <section
      aria-label="Auto-Discover Builds"
      className="overflow-hidden rounded-2xl border border-border bg-bg-surface"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="auto-discover-body"
          className={[
            "inline-flex h-11 items-center gap-2 rounded-md px-2",
            "text-left text-text hover:bg-bg-elevated",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          ].join(" ")}
        >
          <Sparkles className="h-4 w-4 text-accent-cyan" aria-hidden />
          <span className="text-body font-semibold">Auto-Discover Builds</span>
          {open ? (
            <ChevronUp className="h-4 w-4 text-text-muted" aria-hidden />
          ) : (
            <ChevronDown className="h-4 w-4 text-text-muted" aria-hidden />
          )}
        </button>
        <div className="hidden text-caption text-text-muted sm:inline">
          {visible.length > 0
            ? `${visible.length} candidate${visible.length === 1 ? "" : "s"} for ${perspective === "opponent" ? "opponent" : "you"}`
            : "Scanning your unclassified games"}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <PerspectiveToggle value={perspective} onChange={setPerspective} />
          <Button
            variant="secondary"
            size="sm"
            onClick={handleScan}
            loading={swr.isLoading && !!swr.data}
            iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
            title="Re-run the discovery scan against your stored replays."
          >
            Scan now
          </Button>
          {visible.length > 0 ? (
            <Button
              size="sm"
              onClick={handleCreateAll}
              loading={creatingAll}
              disabled={!canCreateAll || creatingAll}
              iconLeft={<Check className="h-4 w-4" aria-hidden />}
              title={`Promote every visible candidate into a custom build (${visible.length}).`}
              // Bumped to 44px min-height so the primary bulk action
              // meets the touch-target rule on mobile while the
              // adjacent secondary "Scan now" button stays compact on
              // desktop. min-h wins over Button's fixed h-8.
              className="min-h-[44px]"
              aria-label={`Create all ${visible.length} discovered builds`}
            >
              Create all
              <span className="ml-1 tabular-nums opacity-80">
                ({visible.length})
              </span>
            </Button>
          ) : null}
        </div>
      </header>

      {open ? (
        <div id="auto-discover-body" className="px-4 py-4 sm:px-6 sm:py-5">
          {hiddenCount > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-caption text-text-muted">
              <Badge variant="neutral" size="sm">
                {hiddenCount} hidden
              </Badge>
              <button
                type="button"
                onClick={clearDismissed}
                className="min-h-[44px] rounded-md px-2 text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Show dismissed
              </button>
            </div>
          ) : null}
          {isLoading ? (
            <DiscoverySkeleton />
          ) : errorMessage ? (
            <ErrorBanner message={errorMessage} onRetry={handleScan} />
          ) : visible.length === 0 ? (
            <EmptyStatePanel
              size="md"
              icon={<Sparkles className="h-5 w-5" aria-hidden />}
              title="No new build patterns yet"
              description="Play at least 5 similar games in a matchup, then run a scan to surface discovered openers."
            />
          ) : (
            <ul
              role="list"
              className="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3"
            >
              {visible.map((c) => {
                const key = dismissKey(c);
                // While "Create all" is in flight every card should
                // present as busy so the user can't fire a single-card
                // create at the same time.
                const cardCreating = creatingAll || creatingKey === key;
                return (
                  <li key={key} className="min-w-0">
                    <AutoCandidateCard
                      candidate={c}
                      onCreate={handleCreate}
                      onDismiss={dismissCandidate}
                      creating={cardCreating}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function PerspectiveToggle({
  value,
  onChange,
}: {
  value: BuildPerspective;
  onChange: (next: BuildPerspective) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Discovery perspective"
      className="inline-flex h-11 items-center rounded-lg border border-border bg-bg-elevated p-0.5"
    >
      <PerspectiveTab
        value="you"
        selected={value === "you"}
        onSelect={onChange}
      >
        You
      </PerspectiveTab>
      <PerspectiveTab
        value="opponent"
        selected={value === "opponent"}
        onSelect={onChange}
      >
        Opponent
      </PerspectiveTab>
    </div>
  );
}

function PerspectiveTab({
  value,
  selected,
  onSelect,
  children,
}: {
  value: BuildPerspective;
  selected: boolean;
  onSelect: (next: BuildPerspective) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => onSelect(value)}
      className={[
        "inline-flex h-10 min-w-[64px] items-center justify-center rounded-md px-3 text-caption font-medium",
        "transition-colors",
        selected
          ? "bg-bg-surface text-text shadow-[var(--shadow-card)]"
          : "text-text-muted hover:text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-danger"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Discovery scan failed</p>
        <p className="mt-0.5 text-text-muted">{message}</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onRetry}
        iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
      >
        Retry
      </Button>
    </div>
  );
}

function DiscoverySkeleton() {
  return (
    <div className="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          aria-hidden
          className="space-y-3 rounded-xl border border-border bg-bg-elevated/40 p-4 sm:p-6"
        >
          <div className="flex flex-wrap gap-2">
            <div className="h-5 w-16 animate-pulse rounded-full bg-bg-elevated" />
            <div className="h-5 w-20 animate-pulse rounded-full bg-bg-elevated" />
            <div className="h-5 w-14 animate-pulse rounded-full bg-bg-elevated" />
          </div>
          <div className="h-6 w-3/5 animate-pulse rounded bg-bg-elevated" />
          <div className="h-1.5 w-full animate-pulse rounded-full bg-bg-elevated" />
          <div className="space-y-2">
            <div className="h-3 w-2/3 animate-pulse rounded bg-bg-elevated" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-bg-elevated" />
          </div>
          <div className="h-10 w-32 animate-pulse rounded-lg bg-bg-elevated" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function dismissKey(c: AutoCandidate): string {
  return `${c.perspective}:${c.matchup}:${c.proposedSlug}`;
}

function loadDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === "string"));
    }
  } catch {
    // ignore malformed storage
  }
  return new Set();
}

function persistDismissed(set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify(Array.from(set)),
    );
  } catch {
    // sessionStorage may be unavailable (e.g. SSR / private mode); ignore.
  }
}

function formatCreatedToastTitle(name: string, tagged: number): string {
  return `Created “${name}” — tagged ${tagged} game${tagged === 1 ? "" : "s"}.`;
}

function formatCreatedAllToastTitle(created: number, tagged: number): string {
  if (created === 0) {
    return tagged === 0
      ? "No new builds created."
      : `Re-tagged ${tagged} game${tagged === 1 ? "" : "s"}.`;
  }
  const buildsPart = `Created ${created} build${created === 1 ? "" : "s"}`;
  const taggedPart = `tagged ${tagged} game${tagged === 1 ? "" : "s"}`;
  return `${buildsPart} — ${taggedPart}.`;
}

function extractErr(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Something went wrong.";
}

/**
 * Pull the most specific text out of an apply-time error. Validation
 * failures from /v1/auto-classify/apply arrive with a `details: string[]`
 * envelope (e.g. ["candidates[2].name must match …"]); surface those
 * verbatim so the user can fix the offending field. Falls back to the
 * humanised message for opaque server errors.
 */
function extractErrDetailed(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as ClientApiError;
    if (Array.isArray(e.details) && e.details.length > 0) {
      return e.details.length === 1 ? e.details[0] : e.details.join(" · ");
    }
    if (typeof e.message === "string" && e.message) return e.message;
  }
  return extractErr(err);
}

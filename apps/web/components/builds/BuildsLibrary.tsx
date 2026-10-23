"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Plus, Library, BookOpen, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { activeBuildFilters, buildFiltersQuery, readBuildFilters } from "./buildLibraryFilters";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { PageHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";
import { Skeleton } from "@/components/ui/Card";
import { coerceRace } from "@/lib/race";
import { BuildCard } from "./BuildCard";
import { BuildFilterBar, type BuildFilterState } from "./BuildFilterBar";
import { BuildPagination } from "./BuildPagination";
import { BuildsPublicIntro } from "./BuildsPublicIntro";
import { useCustomBuildPage } from "./useCustomBuildPage";
import type { BuildStats, CustomBuild, DecoratedBuild } from "./types";
import type { BuildEditorSaveResult } from "./editor/BuildEditor.types";

// Editors and charts are only needed after a library action. Keep them out
// of the route's first load, including for signed-out visitors.
const BuildDossierModal = dynamic(() => import("./BuildDossierModal").then((module) => module.BuildDossierModal));
const BuildEditorSheet = dynamic(() => import("./BuildEditorSheet").then((module) => module.BuildEditorSheet));
const EditCustomBuildLauncher = dynamic(() => import("./EditCustomBuildLauncher").then((module) => module.EditCustomBuildLauncher));
const BuildPublishModal = dynamic(() => import("./BuildPublishModal").then((module) => module.BuildPublishModal));

type ReclassifyResult = {
  ok: true;
  slug: string;
  name: string;
  status: "queued" | "complete";
  generation?: string;
};

type ReclassifyAllResult = {
  ok: true;
  status: "queued" | "complete";
  builds: number;
  generation?: string;
  job?: { generation?: string };
};

type ReclassifyStatus = {
  status: "idle" | "queued" | "running" | "retry" | "complete" | "failed";
  generation?: string;
  requestedAt?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  retryAt?: string;
  attempts?: number;
  progress?: {
    builds?: number;
    scanned?: number;
    tagged?: number;
    cleared?: number;
    deferred?: number;
    total?: number;
  };
  error?: string;
  requestId?: string;
};

const DEFAULT_FILTERS: BuildFilterState = {
  search: "",
  matchup: "All",
  sort: "updated",
  hideEmpty: false,
};

const EMPTY_BUILDS: CustomBuild[] = [];

/**
 * Phase 7 builds library. Toast context comes from the app-wide
 * ToastProvider in the root layout.
 *
 * Auth is settled before anything else: useApi has no key while signed
 * out, so the library's SWR-derived loading state would never resolve
 * and a visitor would watch a skeleton forever. Until Clerk loads the
 * page shows the public intro, as it does for a signed-out visitor
 * (no New build, Reclassify or filters, which all need an account).
 */
export function BuildsLibrary() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded || !isSignedIn) return <BuildsPublicIntro />;
  return <BuildsLibraryInner />;
}

function BuildsLibraryInner() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const [filters, setFilters] = useState<BuildFilterState>(() => readBuildFilters(searchParams));
  const [searchInput, setSearchInput] = useState(filters.search);
  const latestFilters = useRef(filters);
  latestFilters.current = filters;
  const debouncedSearch = useDebouncedValue(searchInput, 250);
  const gridHeading = useRef<HTMLHeadingElement>(null);
  const commitFilters = useCallback((next: BuildFilterState) => {
    setFilters(next);
    const query = buildFiltersQuery(next);
    router.replace(`/builds${query ? `?${query}` : ""}`, { scroll: false });
  }, [router]);
  useEffect(() => {
    const next = readBuildFilters(new URLSearchParams(queryString));
    setFilters(next); setSearchInput(next.search);
  }, [queryString]);
  useEffect(() => {
    if (debouncedSearch === searchInput && debouncedSearch !== latestFilters.current.search)
      commitFilters({ ...latestFilters.current, search: debouncedSearch });
  }, [debouncedSearch, searchInput, commitFilters]);
  const clearFilters = () => { setSearchInput(""); commitFilters({ ...DEFAULT_FILTERS, sort: filters.sort }); };
  const pageChanged = (action: () => void) => {
    action(); requestAnimationFrame(() => {
      gridHeading.current?.focus({ preventScroll: true });
      gridHeading.current?.scrollIntoView?.({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    });
  };
  const builds = useCustomBuildPage(filters);
  // The custom-build endpoint reads the durable provenance slug written by
  // replay matching, so it is the only authoritative source. Display names
  // are not identities: two unrelated builds can share one, and renames must
  // never move replay counts between them.
  const statsSlugs = builds.data?.items.map((build) => build.slug).join(",");
  const stats = useApi<BuildStats[]>(statsSlugs
    ? `/v1/custom-builds/stats?${new URLSearchParams({ slugs: statsSlugs })}`
    : null);
  const reclassifyStatus = useApi<ReclassifyStatus>(
    "/v1/custom-builds/reclassify-status",
    {
      refreshInterval: (latest) => isReclassifyActive(latest) ? 1500 : 0,
      dedupingInterval: 500,
    },
  );

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorBuild, setEditorBuild] = useState<CustomBuild | null>(null);
  const [richEditBuild, setRichEditBuild] = useState<CustomBuild | null>(null);
  const [richEditFocus, setRichEditFocus] = useState<"notes" | "preview" | undefined>();
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBuild, setPublishBuild] = useState<CustomBuild | null>(null);
  const [dossierBuild, setDossierBuild] = useState<CustomBuild | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [reclassifyingSlug, setReclassifyingSlug] = useState<string | null>(null);
  const [reclassifyAllPending, setReclassifyAllPending] = useState(false);
  const [showReclassifyFailure, setShowReclassifyFailure] = useState(false);
  const lastTerminalRef = useRef<string | null>(null);
  const observedActiveGenerationsRef = useRef(new Set<string>());
  const initiatedReclassifyRef = useRef(false);

  const replayMatchingActive = isReclassifyActive(reclassifyStatus.data);

  // A queued request outlives the POST that created it. Keep polling until
  // the durable worker reaches a terminal state, then refresh every library
  // number that depends on replay tags.
  useEffect(() => {
    const current = reclassifyStatus.data;
    if (!current) return;
    if (isReclassifyActive(current)) {
      setShowReclassifyFailure(false);
      if (current.generation) {
        observedActiveGenerationsRef.current.add(current.generation);
      }
      return;
    }
    if (current.status !== "complete" && current.status !== "failed") return;
    const terminalKey = [
      current.generation || "none",
      current.status,
      current.completedAt || current.failedAt || "",
    ].join(":");
    if (lastTerminalRef.current === terminalKey) return;
    const observedThisRun = initiatedReclassifyRef.current
      || (!!current.generation
        && observedActiveGenerationsRef.current.has(current.generation));
    lastTerminalRef.current = terminalKey;
    if (!observedThisRun) return;
    initiatedReclassifyRef.current = false;
    setReclassifyingSlug(null);
    setReclassifyAllPending(false);
    if (current.status === "complete") {
      setShowReclassifyFailure(false);
      const progress = current.progress || {};
      toast.success("Replay matching complete.", {
        description: describeCompletedReclassify(progress),
        duration: progress.deferred ? null : undefined,
      });
      builds.resetPage();
      void Promise.all([
        builds.mutate(),
        stats.mutate(),
      ]).catch(() => undefined);
    } else {
      setShowReclassifyFailure(true);
      toast.error("Replay matching stopped", {
        description: describeReclassifyFailure(current.error),
      });
    }
  }, [reclassifyStatus.data, builds, stats, toast]);

  const items = builds.data?.items ?? EMPTY_BUILDS;
  const decorated = useMemo<DecoratedBuild[]>(
    () => decorateBuilds(items, {
      authoritativeStats: stats.data,
      authoritativeStatsFailed: !!stats.error,
    }),
    [items, stats.data, stats.error],
  );

  // Search, matchup, sorting and empty-build filtering run before server
  // pagination, so they cover every saved build instead of only this page.
  const filtered = decorated;

  const openCreate = useCallback(() => {
    setEditorBuild(null);
    setEditorOpen(true);
  }, []);

  const openDossier = useCallback(
    (slug: string) => {
      const target = items.find((b) => b.slug === slug) || null;
      setDossierBuild(target);
    },
    [items],
  );

  const openEdit = useCallback(
    (slug: string, initialFocus?: "notes" | "preview") => {
      const target = items.find((b) => b.slug === slug) || null;
      // Opens the rich rule-based editor (the same modal used by
      // "Save as new build") pre-populated with the existing build.
      setRichEditBuild(target);
      setRichEditFocus(initialFocus);
      setDossierBuild(null);
    },
    [items],
  );

  const openPublish = useCallback(
    (slug: string) => {
      const target = items.find((b) => b.slug === slug) || null;
      setPublishBuild(target);
      setPublishOpen(true);
      setDossierBuild(null);
    },
    [items],
  );

  const askDelete = useCallback((slug: string) => {
    setDeletingSlug(slug);
    setDossierBuild(null);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deletingSlug) return;
    setDeletePending(true);
    try {
      await apiCall<void>(
        getToken,
        `/v1/custom-builds/${encodeURIComponent(deletingSlug)}`,
        { method: "DELETE" },
      );
      toast.success("Build deleted.");
      builds.resetPage();
      await builds.mutate();
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Delete failed.";
      toast.error("Couldn’t delete build", { description: message });
    } finally {
      setDeletePending(false);
      setDeletingSlug(null);
    }
  }, [deletingSlug, getToken, builds, toast]);

  const handleSaved = useCallback(
    async (saved: CustomBuild, result?: BuildEditorSaveResult) => {
      if (!result) toast.success(
        editorBuild ? `Saved “${saved.name}”.` : `Created “${saved.name}”.`,
      );
      if (!result?.reclassifyError && result?.reclassifyRequested) {
        initiatedReclassifyRef.current = true;
        if (result.reclassifyStatus === "queued"
          || result.reclassifyStatus === "running"
          || result.reclassifyStatus === "retry") {
          void reclassifyStatus.mutate(
            {
              status: result.reclassifyStatus,
              generation: result.reclassifyGeneration,
            },
            { revalidate: true },
          ).catch(() => undefined);
          toast.success("Replay matching is running in the background.");
        } else {
          void reclassifyStatus.mutate().catch(() => undefined);
        }
      }
      // The save/queue response is authoritative. A secondary list refresh
      // must never hide confirmed background work or reject the save callback.
      builds.resetPage();
      void builds.mutate().catch(() => undefined);
    },
    [editorBuild, builds, reclassifyStatus, toast],
  );

  const handlePublished = useCallback(
    async (slug: string) => {
      toast.success(`Published to /community/builds/${slug}.`);
      builds.resetPage();
      await builds.mutate();
    },
    [builds, toast],
  );

  const reclassifyOne = useCallback(
    async (slug: string) => {
      const target = items.find((b) => b.slug === slug);
      if (!target) return;
      initiatedReclassifyRef.current = true;
      setShowReclassifyFailure(false);
      setReclassifyingSlug(slug);
      try {
        const res = await apiCall<ReclassifyResult>(
          getToken,
          `/v1/custom-builds/${encodeURIComponent(slug)}/reclassify`,
          { method: "POST", body: JSON.stringify({ replace: true }) },
        );
        toast.success(`Replay matching queued for “${res.name}”.`, {
          description: "Your full replay history will update safely in the background.",
        });
        void reclassifyStatus.mutate(
          { status: "queued", generation: res.generation },
          { revalidate: true },
        ).catch(() => undefined);
      } catch (err) {
        initiatedReclassifyRef.current = false;
        toast.error("Couldn’t re-match replays", {
          description: extractErr(err),
        });
        setReclassifyingSlug(null);
      }
    },
    [getToken, items, reclassifyStatus, toast],
  );

  const reclassifyAll = useCallback(async () => {
    initiatedReclassifyRef.current = true;
    setShowReclassifyFailure(false);
    setReclassifyAllPending(true);
    try {
      const res = await apiCall<ReclassifyAllResult>(
        getToken,
        "/v1/custom-builds/reclassify-all",
        { method: "POST", body: JSON.stringify({ clearUnmatched: true }) },
      );
      toast.success(`Replay matching queued for ${res.builds} build${res.builds === 1 ? "" : "s"}.`, {
        description: "Your full replay history will update safely in the background.",
      });
      void reclassifyStatus.mutate(
        {
          status: "queued",
          generation: res.generation || res.job?.generation,
        },
        { revalidate: true },
      ).catch(() => undefined);
    } catch (err) {
      initiatedReclassifyRef.current = false;
      toast.error("Couldn’t re-match replays", {
        description: extractErr(err),
      });
      setReclassifyAllPending(false);
    }
  }, [getToken, reclassifyStatus, toast]);

  const isInitialLoad = !builds.data && !builds.error;
  const totalCount = builds.data?.total ?? decorated.length;
  const libraryCount = builds.data?.libraryTotal ?? totalCount;
  const showFilters = libraryCount > 0 || !!filters.search || filters.matchup !== "All"
    || filters.hideEmpty || filters.sort !== "updated" || builds.hasPrevious;
  const filteredCount = filtered.length;
  const targetForDelete =
    deletingSlug != null ? items.find((b) => b.slug === deletingSlug) : null;

  return (
    <>
      <PageHeader
        eyebrow="Build library"
        title="Your build library"
        description="Custom openers synced across devices. Save them privately, share them publicly, and match your replays automatically."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/definitions"
              className="hard-press inline-flex min-h-[44px] items-center gap-2 rounded-full border-2 border-line bg-bg-surface px-5 font-display text-body font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <BookOpen className="h-4 w-4" aria-hidden />
              Definitions
            </Link>
            {libraryCount > 0 ? (
              <Button
                variant="secondary"
                onClick={reclassifyAll}
                loading={reclassifyAllPending || replayMatchingActive}
                disabled={replayMatchingActive}
                iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
              >
                {replayMatchingActive ? "Matching replays…" : "Re-match replays"}
              </Button>
            ) : null}
            <Button
              onClick={openCreate}
              iconLeft={<Plus className="h-4 w-4" aria-hidden />}
            >
              New build
            </Button>
          </div>
        }
      />

      <p className="my-3 text-caption text-text-muted">Re-match checks every saved replay against your build rules again. It runs in the cloud, so you can leave this page.</p>
      {replayMatchingActive || showReclassifyFailure || reclassifyStatus.data?.status === "failed" ? (
        <ReclassifyStatusPanel status={reclassifyStatus.data} onRetry={reclassifyAll} />
      ) : null}

      {builds.error ? (
        <section
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/60 bg-warning/10 px-4 py-3 text-caption text-text"
        >
          <div>
            <p className="font-semibold">
              {decorated.length > 0
                ? "Couldn't refresh your build library"
                : "Couldn't load your build library"}
            </p>
            <p className="mt-0.5 text-text-muted">
              {decorated.length > 0
                ? "Showing your previously loaded builds. Retry to check for changes."
                : "Your saved builds couldn't be retrieved. Retry to load them."}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={builds.isValidating}
            onClick={() => { void builds.mutate().catch(() => undefined); }}
            iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
          >
            Retry
          </Button>
        </section>
      ) : null}

      {showFilters ? (
        <BuildFilterBar
          value={{ ...filters, search: searchInput }}
          onChange={(next) => {
            setSearchInput(next.search);
            if (next.search !== searchInput && next.search) return;
            commitFilters({ ...next, search: next.search ? filters.search : "" });
          }}
          onSearchCommit={() => commitFilters({ ...filters, search: searchInput })}
          updating={!!builds.data && builds.isValidating}
          onClearFilters={clearFilters}
          total={totalCount}
          libraryTotal={builds.data?.libraryTotal}
        />
      ) : null}
      <h2 ref={gridHeading} tabIndex={-1} className="my-3 text-h3 font-semibold focus:outline-none">Saved builds</h2>
      {isInitialLoad ? (
        <div className="space-y-4">
          <Skeleton rows={1} />
          <Skeleton rows={4} />
        </div>
      ) : filteredCount === 0 && builds.isValidating ? (
        <p role="status" className="py-6 text-caption text-text-muted">Updating build matches…</p>
      ) : libraryCount === 0 && !filters.search && filters.matchup === "All" && !filters.hideEmpty ? (
        builds.error ? null : <FirstRunEmptyState onCreate={openCreate} />
      ) : (
        <>
          {filteredCount === 0 && !builds.error ? (
            <EmptyStatePanel
              size="md"
              icon={<Library className="h-5 w-5" aria-hidden />}
              title="No builds match these filters"
              description={activeBuildFilters(filters).join(" · ")}
              action={<Button variant="secondary" onClick={clearFilters}>Clear filters</Button>}
            />
          ) : (
            <ul aria-busy={builds.isValidating || undefined} className={`grid gap-4 transition-opacity motion-reduce:transition-none sm:grid-cols-2 lg:grid-cols-3 ${builds.isValidating ? "opacity-60" : ""}`}>
              {filtered.map((b) => (
                <li key={b.slug}>
                  <BuildCard
                    build={b}
                    onOpen={openDossier}
                    onEdit={openEdit}
                    onDelete={askDelete}
                    onPublish={openPublish}
                    onReclassify={reclassifyOne}
                    reclassifying={reclassifyingSlug === b.slug}
                    reclassifyDisabled={
                      replayMatchingActive
                      || reclassifyAllPending
                      || !!reclassifyingSlug
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <BuildPagination
        {...builds}
        count={items.length}
        total={builds.data?.total}
        loading={builds.isValidating}
        onPrevious={() => pageChanged(builds.previousPage)}
        onNext={() => pageChanged(builds.nextPage)}
      />

      {dossierBuild ? (
        <BuildDossierModal
          build={dossierBuild}
          onClose={() => setDossierBuild(null)}
          onEdit={openEdit}
          onPublish={openPublish}
          onDelete={askDelete}
        />
      ) : null}
      {editorOpen ? <BuildEditorSheet
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        build={editorBuild}
        onSaved={handleSaved}
      /> : null}
      {richEditBuild ? <EditCustomBuildLauncher
        build={richEditBuild}
        initialFocus={richEditFocus}
        onClose={() => setRichEditBuild(null)}
        onSaved={async (saved, result) => {
          await handleSaved(saved, result);
          setRichEditBuild(null);
        }}
      /> : null}
      {publishOpen ? <BuildPublishModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        build={publishBuild}
        onPublished={handlePublished}
      /> : null}
      <ConfirmDialog
        open={!!deletingSlug}
        onClose={() => (deletePending ? undefined : setDeletingSlug(null))}
        onConfirm={confirmDelete}
        intent="danger"
        loading={deletePending}
        title="Delete this build?"
        description={
          targetForDelete
            ? `“${targetForDelete.name}” will be removed from your library on every signed-in device.`
            : "This build will be removed from your library on every signed-in device."
        }
        confirmLabel="Delete build"
      />
    </>
  );
}

function isReclassifyActive(
  status: ReclassifyStatus | undefined,
): boolean {
  return status?.status === "queued"
    || status?.status === "running"
    || status?.status === "retry";
}

function describeCompletedReclassify(
  progress: NonNullable<ReclassifyStatus["progress"]>,
): string {
  const tagged = Math.max(0, Number(progress.tagged) || 0);
  const cleared = Math.max(0, Number(progress.cleared) || 0);
  const deferred = Math.max(0, Number(progress.deferred) || 0);
  const applied = `${tagged.toLocaleString()} games matched · ${cleared.toLocaleString()} old matches removed.`;
  return deferred > 0
    ? `${applied} ${deferred.toLocaleString()} replay${deferred === 1 ? " was" : "s were"} left unchanged because analysis data was unavailable; re-sync the desktop app to repair ${deferred === 1 ? "it" : "them"}.`
    : applied;
}

function ReclassifyStatusPanel({
  status, onRetry,
}: {
  status: ReclassifyStatus | undefined;
  onRetry: () => unknown;
}) {
  if (!status) return null;
  const progress = status.progress || {};
  const total = Math.max(0, Number(progress.total) || 0);
  const scanned = Math.max(0, Number(progress.scanned) || 0);
  const deferred = Math.max(0, Number(progress.deferred) || 0);
  const failed = status.status === "failed";
  const retrying = status.status === "retry"
    || (status.status === "queued" && (status.attempts || 0) > 0);
  return (
    <section
      aria-live="polite"
      aria-busy={isReclassifyActive(status) || undefined}
      className={[
        "mb-4 flex flex-wrap items-center gap-3 rounded-xl border-2 px-4 py-3 shadow-hard",
        failed
          ? "border-danger/50 bg-danger/10"
          : "border-line bg-bg-surface",
      ].join(" ")}
    >
      {failed ? (
        <RefreshCw className="h-5 w-5 text-danger" aria-hidden />
      ) : (
        <RefreshCw className="h-5 w-5 animate-spin text-accent" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-display text-body font-bold text-text">
          {failed
            ? "Replay matching stopped"
            : retrying
              ? "Retrying replay matching safely…"
              : status.status === "queued"
                ? "Replay matching is queued…"
                : "Matching replay history…"}
        </p>
        <p className="text-caption text-text-muted">
          {failed
            ? describeReclassifyFailure(status.error)
            : `${scanned.toLocaleString()}${total > 0 ? ` of ${total.toLocaleString()}` : ""} replays checked${total > 0 ? "" : " so far"}${deferred > 0 ? ` · ${deferred.toLocaleString()} waiting for replay data` : ""}`}
        </p>
        {!failed && total > 0 ? <div role="progressbar" aria-label="Replays checked" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(scanned, total)} className="mt-2 h-2 rounded bg-bg-elevated"><div className="h-2 rounded bg-accent" style={{ width: `${Math.min(100, scanned / total * 100)}%` }} /></div> : null}
        {status.requestId ? <p className="text-caption">Error ID: {status.requestId}</p> : null}
      </div>
      {failed ? <Button variant="secondary" onClick={onRetry}>Try again</Button> : null}
    </section>
  );
}

function describeReclassifyFailure(error?: string): string {
  if (error === "reclassify_queue_failed") return "Replay matching couldn't join the queue. Your saved builds are safe. Try again.";
  if (error === "reclassify_unavailable") return "Replay matching is temporarily unavailable. Your saved builds are safe. Try again in a moment.";
  if (error && /timeout|timed_out/i.test(error)) return "Replay matching took too long. Your saved builds are safe. Try again.";
  return "Your saved builds and existing replay tags are safe. Try re-matching again in a moment.";
}

function extractErr(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Something went wrong.";
}

function FirstRunEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="relative overflow-hidden rounded-2xl border-2 border-line bg-bg-surface p-8 shadow-hard sm:p-12">
      <GlowHalo color="cyan" position="top" opacity={0.85} size={70} />
      <div className="relative">
        <EmptyStatePanel
          size="lg"
          icon={<Sparkles className="h-6 w-6" aria-hidden />}
          title="No custom builds yet"
          description="Save your favourite openers so your replays can be matched to them. From any game’s build order, click ‘Save as new build’ to capture an opener from a real game."
          action={
            <Button
              size="lg"
              onClick={onCreate}
              iconLeft={<Plus className="h-5 w-5" aria-hidden />}
            >
              Create your first build
            </Button>
          }
        />
      </div>
    </section>
  );
}

function decorateBuilds(
  items: CustomBuild[],
  sources: {
    authoritativeStats?: BuildStats[];
    authoritativeStatsFailed: boolean;
  },
): DecoratedBuild[] {
  const authoritativeBySlug = new Map<string, BuildStats>();
  for (const s of sources.authoritativeStats ?? []) {
    if (s?.slug) authoritativeBySlug.set(s.slug, s);
  }
  return items.map((b) => {
    if (sources.authoritativeStatsFailed) {
      return {
        ...b,
        race: coerceRace(b.race, "Random"),
        // An SWR refresh can expose stale data alongside its latest error.
        // Fail closed instead of presenting an old count as current.
        statsState: "unavailable",
      };
    }
    if (sources.authoritativeStats !== undefined) {
      return {
        ...b,
        race: coerceRace(b.race, "Random"),
        stats: authoritativeBySlug.get(b.slug),
        statsState: "ready",
        statsSource: "classified",
      };
    }
    return {
      ...b,
      race: coerceRace(b.race, "Random"),
      statsState: "loading",
    };
  });
}

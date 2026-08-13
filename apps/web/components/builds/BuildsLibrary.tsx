"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Plus, Library, BookOpen, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
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
import { BuildDossierModal } from "./BuildDossierModal";
import { BuildEditorSheet } from "./BuildEditorSheet";
import { EditCustomBuildLauncher } from "./EditCustomBuildLauncher";
import { BuildFilterBar, type BuildFilterState } from "./BuildFilterBar";
import { BuildPublishModal } from "./BuildPublishModal";
import type { BuildStats, CustomBuild, DecoratedBuild } from "./types";
import type { BuildEditorSaveResult } from "./editor/BuildEditor.types";

type ListResponse = { items: CustomBuild[] };

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
  };
  error?: string;
};

const DEFAULT_FILTERS: BuildFilterState = {
  search: "",
  matchup: "All",
  sort: "updated",
  hideEmpty: false,
};

/**
 * Phase 7 builds library. Toast context comes from the app-wide
 * ToastProvider in the root layout.
 */
export function BuildsLibrary() {
  return <BuildsLibraryInner />;
}

function BuildsLibraryInner() {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const builds = useApi<ListResponse>("/v1/custom-builds");
  // Custom-build stats come from rule evaluation against the user's
  // recent games — see /v1/custom-builds/stats — so a freshly saved
  // build's W/L appears immediately, instead of waiting for the agent
  // to reclassify games and tag `myBuild`.
  const stats = useApi<BuildStats[]>("/v1/custom-builds/stats");
  const reclassifyStatus = useApi<ReclassifyStatus>(
    "/v1/custom-builds/reclassify-status",
    {
      refreshInterval: (latest) => isReclassifyActive(latest) ? 1500 : 0,
      dedupingInterval: 500,
    },
  );

  const [filters, setFilters] = useState<BuildFilterState>(DEFAULT_FILTERS);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorBuild, setEditorBuild] = useState<CustomBuild | null>(null);
  const [richEditBuild, setRichEditBuild] = useState<CustomBuild | null>(null);
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
      void Promise.all([builds.mutate(), stats.mutate()]).catch(() => undefined);
    } else {
      setShowReclassifyFailure(true);
      toast.error("Replay matching stopped", {
        description: describeReclassifyFailure(current.error),
      });
    }
  }, [reclassifyStatus.data, builds, stats, toast]);

  const items = builds.data?.items ?? [];
  const decorated = useMemo<DecoratedBuild[]>(
    () => decorateBuilds(items, stats.data ?? []),
    [items, stats.data],
  );

  const filtered = useMemo(
    () => applyFilters(decorated, filters),
    [decorated, filters],
  );

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
    (slug: string) => {
      const target = items.find((b) => b.slug === slug) || null;
      // Opens the rich rule-based editor (the same modal used by
      // "Save as new build") pre-populated with the existing build.
      setRichEditBuild(target);
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
      toast.success(
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
      void builds.mutate().catch(() => undefined);
    },
    [editorBuild, builds, reclassifyStatus, toast],
  );

  const handlePublished = useCallback(
    async (slug: string) => {
      toast.success(`Published to /community/builds/${slug}.`);
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
        toast.error("Couldn’t reclassify replays", {
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
      toast.error("Couldn’t reclassify replays", {
        description: extractErr(err),
      });
      setReclassifyAllPending(false);
    }
  }, [getToken, reclassifyStatus, toast]);

  const isInitialLoad = !builds.data && builds.isLoading;
  const totalCount = decorated.length;
  const filteredCount = filtered.length;
  const targetForDelete =
    deletingSlug != null ? items.find((b) => b.slug === deletingSlug) : null;

  return (
    <>
      <PageHeader
        eyebrow="Custom builds"
        title="Your build library"
        description="Custom openers synced across devices. Save them privately, share them publicly, classify your replays automatically."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/definitions"
              className="hard-press inline-flex min-h-[44px] items-center gap-2 rounded-full border-2 border-line bg-bg-surface px-5 font-display text-body font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <BookOpen className="h-4 w-4" aria-hidden />
              Definitions
            </Link>
            {decorated.length > 0 ? (
              <Button
                variant="secondary"
                onClick={reclassifyAll}
                loading={reclassifyAllPending || replayMatchingActive}
                disabled={replayMatchingActive}
                iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
                title="Re-evaluate every saved build's rules against your stored replays and update build tags. Runs in the cloud — no agent required."
              >
                {replayMatchingActive ? "Matching replays…" : "Reclassify replays"}
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

      {replayMatchingActive || showReclassifyFailure ? (
        <ReclassifyStatusPanel status={reclassifyStatus.data} />
      ) : null}

      {isInitialLoad ? (
        <div className="space-y-4">
          <Skeleton rows={1} />
          <Skeleton rows={4} />
        </div>
      ) : decorated.length === 0 ? (
        <FirstRunEmptyState onCreate={openCreate} />
      ) : (
        <>
          <BuildFilterBar
            value={filters}
            onChange={setFilters}
            total={totalCount}
            shown={filteredCount}
          />
          {filteredCount === 0 ? (
            <EmptyStatePanel
              size="md"
              icon={<Library className="h-5 w-5" aria-hidden />}
              title="No builds match these filters"
              description="Clear the matchup pill, lower the search, or untoggle Hide empty."
            />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                      replayMatchingActive || reclassifyAllPending || !!reclassifyingSlug
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {dossierBuild ? (
        <BuildDossierModal
          build={dossierBuild}
          onClose={() => setDossierBuild(null)}
          onEdit={openEdit}
          onPublish={openPublish}
          onDelete={askDelete}
        />
      ) : null}
      <BuildEditorSheet
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        build={editorBuild}
        onSaved={handleSaved}
      />
      <EditCustomBuildLauncher
        build={richEditBuild}
        onClose={() => setRichEditBuild(null)}
        onSaved={async (saved, result) => {
          await handleSaved(saved, result);
          setRichEditBuild(null);
        }}
      />
      <BuildPublishModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        build={publishBuild}
        onPublished={handlePublished}
      />
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

function describeReclassify({
  tagged,
  cleared,
  matched,
}: {
  tagged: number;
  cleared: number;
  matched: number;
}): string {
  if (tagged === 0 && cleared === 0) {
    return matched > 0
      ? `${matched} game${matched === 1 ? "" : "s"} already tagged — nothing to update.`
      : "No games matched. Try adjusting your rules and saving the build again.";
  }
  const parts: string[] = [];
  if (tagged > 0) parts.push(`Tagged ${tagged} game${tagged === 1 ? "" : "s"}`);
  if (cleared > 0)
    parts.push(`cleared ${cleared} stale tag${cleared === 1 ? "" : "s"}`);
  return parts.join(" · ");
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
  const scanned = Math.max(0, Number(progress.scanned) || 0);
  const tagged = Math.max(0, Number(progress.tagged) || 0);
  const cleared = Math.max(0, Number(progress.cleared) || 0);
  const deferred = Math.max(0, Number(progress.deferred) || 0);
  const applied = `${scanned.toLocaleString()} replay${scanned === 1 ? "" : "s"} checked · ${tagged.toLocaleString()} tagged · ${cleared.toLocaleString()} stale tag${cleared === 1 ? "" : "s"} cleared.`;
  return deferred > 0
    ? `${applied} ${deferred.toLocaleString()} replay${deferred === 1 ? " was" : "s were"} left unchanged because analysis data was unavailable; re-sync the agent to repair ${deferred === 1 ? "it" : "them"}.`
    : applied;
}

function ReclassifyStatusPanel({
  status,
}: {
  status: ReclassifyStatus | undefined;
}) {
  if (!status) return null;
  const progress = status.progress || {};
  const scanned = Math.max(0, Number(progress.scanned) || 0);
  const tagged = Math.max(0, Number(progress.tagged) || 0);
  const cleared = Math.max(0, Number(progress.cleared) || 0);
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
            : `${scanned.toLocaleString()} checked · ${tagged.toLocaleString()} tag changes found · ${cleared.toLocaleString()} stale removals planned${deferred > 0 ? ` · ${deferred.toLocaleString()} awaiting replay data` : ""}`}
        </p>
      </div>
    </section>
  );
}

function describeReclassifyFailure(_error?: string): string {
  return "Your saved builds and existing replay tags are safe. Try reclassifying again in a moment.";
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
          description="Save your favourite openers so the classifier learns them. From inside any opponent profile, click ‘Save as new build’ to capture an opener from a real game."
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
  stats: BuildStats[],
): DecoratedBuild[] {
  const byName = new Map<string, BuildStats>();
  for (const s of stats) {
    if (!s?.name) continue;
    byName.set(s.name, s);
  }
  return items.map((b) => ({
    ...b,
    race: coerceRace(b.race, "Random"),
    stats: byName.get(b.name),
  }));
}

function applyFilters(
  builds: DecoratedBuild[],
  filters: BuildFilterState,
): DecoratedBuild[] {
  const q = filters.search.trim().toLowerCase();
  const filtered = builds.filter((b) => {
    if (filters.hideEmpty && (b.stats?.total ?? 0) === 0) return false;
    if (filters.matchup !== "All") {
      const want = filters.matchup;
      const have = matchupKeyForBuild(b);
      if (have !== want) return false;
    }
    if (q) {
      const hay = [
        b.name,
        b.description ?? "",
        b.notes ?? "",
        matchupKeyForBuild(b),
        b.race,
        b.vsRace ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  filtered.sort((a, b) => compareBy(a, b, filters.sort));
  return filtered;
}

function matchupKeyForBuild(b: DecoratedBuild): string {
  const my = b.race[0] ?? "?";
  const vs = b.vsRace && b.vsRace !== "Any" ? b.vsRace[0] : "";
  if (!vs) return my;
  return `${my}v${vs}`;
}

function compareBy(
  a: DecoratedBuild,
  b: DecoratedBuild,
  sort: BuildFilterState["sort"],
): number {
  switch (sort) {
    case "winRate": {
      const aw = a.stats?.winRate ?? -1;
      const bw = b.stats?.winRate ?? -1;
      return bw - aw;
    }
    case "games": {
      const aw = a.stats?.total ?? 0;
      const bw = b.stats?.total ?? 0;
      return bw - aw;
    }
    case "name":
      return a.name.localeCompare(b.name);
    case "updated":
    default: {
      const aTs = new Date(a.updatedAt ?? 0).getTime();
      const bTs = new Date(b.updatedAt ?? 0).getTime();
      return bTs - aTs;
    }
  }
}

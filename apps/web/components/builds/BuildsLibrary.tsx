"use client";

import { useCallback, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Plus, Library, BookOpen, Sparkles } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { PageHeader } from "@/components/ui/PageHeader";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";
import { Skeleton } from "@/components/ui/Card";
import { coerceRace } from "@/lib/race";
import { BuildCard } from "./BuildCard";
import { BuildDossierModal } from "./BuildDossierModal";
import { BuildEditorSheet } from "./BuildEditorSheet";
import { BuildFilterBar, type BuildFilterState } from "./BuildFilterBar";
import { BuildPublishModal } from "./BuildPublishModal";
import type { BuildStats, CustomBuild, DecoratedBuild } from "./types";

type ListResponse = { items: CustomBuild[] };

const DEFAULT_FILTERS: BuildFilterState = {
  search: "",
  matchup: "All",
  sort: "updated",
  hideEmpty: false,
};

/**
 * Phase 7 builds library — wrapped in ToastProvider so kebab actions
 * can fire ephemeral status messages without bubbling state up.
 */
export function BuildsLibrary() {
  return (
    <ToastProvider>
      <BuildsLibraryInner />
    </ToastProvider>
  );
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

  const [filters, setFilters] = useState<BuildFilterState>(DEFAULT_FILTERS);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorBuild, setEditorBuild] = useState<CustomBuild | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBuild, setPublishBuild] = useState<CustomBuild | null>(null);
  const [dossierBuild, setDossierBuild] = useState<CustomBuild | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);

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
      setEditorBuild(target);
      setEditorOpen(true);
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
    async (saved: CustomBuild) => {
      toast.success(
        editorBuild ? `Saved “${saved.name}”.` : `Created “${saved.name}”.`,
      );
      await builds.mutate();
    },
    [editorBuild, builds, toast],
  );

  const handlePublished = useCallback(
    async (slug: string) => {
      toast.success(`Published to /community/builds/${slug}.`);
      await builds.mutate();
    },
    [builds, toast],
  );

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
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 text-body font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <BookOpen className="h-4 w-4" aria-hidden />
              Definitions
            </Link>
            <Button
              onClick={openCreate}
              iconLeft={<Plus className="h-4 w-4" aria-hidden />}
            >
              New build
            </Button>
          </div>
        }
      />

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

function FirstRunEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-border bg-bg-surface p-8 sm:p-12">
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

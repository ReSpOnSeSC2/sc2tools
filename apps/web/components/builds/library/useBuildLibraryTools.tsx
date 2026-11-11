"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Dices, Download, ListChecks, Pin, PinOff, Share2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";
import {
  TRASH_PATH,
  UNDO_WINDOW_MS,
  authorUpdated,
  buildPath,
  communityVersionsPath,
  encodeShareCode,
  fetchLibraryExport,
  normalizeTags,
  patchBuildMeta,
  restoreDeletedBuild,
  shareImportHref,
  type CommunityVersion,
  type TrashResponse,
} from "@/lib/buildLibrary";
import type { CustomBuild } from "../types";
import type { BulkAction } from "./BuildBulkBar";

// Everything here except the toolbar loads on first use: /builds keeps its budget.
const BuildBulkBar = dynamic(() => import("./BuildBulkBar").then((m) => m.BuildBulkBar));
const RecentlyDeletedDrawer = dynamic(() => import("./RecentlyDeletedDrawer").then((m) => m.RecentlyDeletedDrawer));
const ImportBuildsDialog = dynamic(() => import("./ImportBuildsDialog").then((m) => m.ImportBuildsDialog));
const ReviewUpdateModal = dynamic(() => import("./ReviewUpdateModal").then((m) => m.ReviewUpdateModal));

/** An extra kebab menu entry (Pin, Copy share code, Add to randomizer pool). */
export interface KebabExtra {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}

type Deleted = Pick<CustomBuild, "slug" | "name" | "isPublic">;

const LINK = "font-semibold text-accent-cyan underline-offset-2 hover:underline";

function errorText(err: unknown): string {
  return err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Try again in a moment.";
}

function errorStatus(err: unknown): number | null {
  return err && typeof err === "object" && "status" in err && typeof (err as { status?: unknown }).status === "number"
    ? (err as { status: number }).status : null;
}

function downloadJson(body: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The build library's safety and organisation tools in one place: delete
 * with a 10 s Undo, "Recently deleted", pin, tags, share codes, the
 * randomizer pool, selection mode with bulk actions, import/export and the
 * "Author updated" review for saved community copies. Returns the toolbar,
 * per-card props and the overlays to render.
 */
export function useBuildLibraryTools({ items, refresh }: { items: ReadonlyArray<CustomBuild>; refresh: () => void }) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const trash = useApi<TrashResponse>(TRASH_PATH, { revalidateOnFocus: false });
  const [trashOpen, setTrashOpen] = useState(false);
  const [importSource, setImportSource] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [review, setReview] = useState<{ build: CustomBuild; version: number } | null>(null);
  const versions = useApi<{ items: CommunityVersion[] }>(
    communityVersionsPath(items.map((build) => build.forkedFrom?.communitySlug)),
    { revalidateOnFocus: false },
  );
  const versionBySlug = useMemo(() => new Map((versions.data?.items ?? []).map((item) => [item.slug, item])), [versions.data]);

  // A page change or filter drops selections that are no longer on screen.
  useEffect(() => {
    setSelected((current) => {
      const onPage = new Set(items.map((build) => build.slug));
      const next = new Set([...current].filter((slug) => onPage.has(slug)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const undoDelete = useCallback(async (builds: ReadonlyArray<Deleted>) => {
    const restored: Deleted[] = [];
    for (const build of builds) {
      try {
        await restoreDeletedBuild(getToken, build.slug);
        restored.push(build);
      } catch { /* Reported below; the rest still restore. */ }
    }
    void trash.mutate();
    refresh();
    if (restored.length < builds.length) {
      toast.error("Some builds couldn’t be restored", { description: "Open Recently deleted to try again." });
    } else if (restored.some((build) => build.isPublic)) {
      toast.success("Restored privately. Publish again to relist it.");
    } else {
      toast.success(restored.length === 1 ? `Restored “${restored[0].name}”` : `Restored ${restored.length} builds`);
    }
    return restored.length === builds.length;
  }, [getToken, refresh, toast, trash]);

  /** The "Deleted … · Undo" toast (10 s) after one or more deletes. */
  const announceDeleted = useCallback((builds: ReadonlyArray<Deleted>, onUndone?: () => void) => {
    void trash.mutate();
    if (builds.length === 0) return;
    let id = "";
    id = toast.success(builds.length === 1 ? `Deleted “${builds[0].name}”` : `Deleted ${builds.length} builds`, {
      duration: UNDO_WINDOW_MS,
      description: (
        <button
          type="button"
          className={`min-h-11 ${LINK}`}
          onClick={() => {
            toast.dismiss(id);
            void undoDelete(builds).then((ok) => { if (ok) onUndone?.(); });
          }}
        >
          Undo
        </button>
      ),
    });
  }, [toast, trash, undoDelete]);

  const setPinned = async (build: CustomBuild, pinned: boolean) => {
    try {
      await patchBuildMeta(getToken, build.slug, { pinned });
      toast.success(pinned ? `Pinned “${build.name}” to the top` : `Unpinned “${build.name}”`);
      refresh();
    } catch (err) {
      toast.error("Couldn’t change the pin", { description: errorText(err) });
    }
  };

  const copyShareCode = async (build: CustomBuild) => {
    try {
      const link = `${window.location.origin}${shareImportHref(encodeShareCode(build as unknown as Record<string, unknown>))}`;
      await navigator.clipboard.writeText(link);
      toast.success("Share link copied", { description: "Anyone signed in can import the build from it. Your notes aren’t included." });
    } catch (err) {
      toast.error("Couldn’t copy a share code", {
        description: err instanceof Error && err.message === "share_code_too_large" ? "This build is too large for a share code. Use Export instead." : errorText(err),
      });
    }
  };

  const addToRandomizer = async (builds: ReadonlyArray<CustomBuild>) => {
    try {
      const { addBuildsToPool } = await import("@/lib/randomizer/addToPool");
      const result = addBuildsToPool(await apiCall<unknown>(getToken, "/v1/me/preferences/randomizer"), builds);
      if (result.added === 0) {
        toast.info("Nothing to add", { description: "These builds are already in their matchup pools, or no pool fits them." });
        return;
      }
      const pool = { ...result.config };
      delete pool.rollOnDesktop;
      await apiCall(getToken, "/v1/me/preferences/randomizer", { method: "PUT", body: JSON.stringify(pool) });
      toast.success(`Added to the randomizer: ${result.matchups.join(", ")}`, {
        description: <Link href="/settings?tab=randomizer" className={LINK}>Randomizer settings</Link>,
      });
    } catch (err) {
      toast.error("Couldn’t update the randomizer", { description: errorText(err) });
    }
  };

  const exportBuilds = async (slugs?: ReadonlySet<string>) => {
    try {
      const body = await fetchLibraryExport(getToken);
      const builds = slugs ? body.builds.filter((build) => slugs.has(String(build.slug))) : body.builds;
      downloadJson({ ...body, builds }, `sc2tools-builds-${new Date().toISOString().slice(0, 10)}.json`);
      toast.success(`Exported ${builds.length} build${builds.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error("Couldn’t export builds", { description: errorText(err) });
    }
  };

  const chosen = () => items.filter((build) => selected.has(build.slug));

  /** Publish or unpublish one at a time through the per-build path; a 429 stops it. */
  const bulkPublication = async (builds: CustomBuild[], publish: boolean) => {
    let done = 0;
    let failed = "";
    for (const build of builds.filter((item) => !!item.isPublic !== publish)) {
      try {
        if (publish) {
          await apiCall(getToken, "/v1/community/builds", { method: "POST", body: JSON.stringify({ slug: build.slug, title: build.name }) });
        } else {
          const owner = await apiCall<{ publicSlug: string | null }>(getToken, `/v1/community/my-build-publication/${encodeURIComponent(build.slug)}`);
          if (owner.publicSlug) await apiCall(getToken, `/v1/community/builds/${encodeURIComponent(owner.publicSlug)}`, { method: "DELETE" });
        }
        done += 1;
      } catch (err) {
        failed = errorStatus(err) === 429 ? "Too many publishing changes at once. Try the rest later." : errorText(err);
        if (errorStatus(err) === 429) break;
      }
    }
    const verb = publish ? "Published" : "Unpublished";
    if (failed) toast.error(`${verb} ${done} build${done === 1 ? "" : "s"}; some didn’t go through`, { description: failed });
    else toast.success(`${verb} ${done} build${done === 1 ? "" : "s"}`);
  };

  const bulkTag = async (tag: string, mode: "add" | "remove") => {
    setBulkBusy(true);
    let changed = 0;
    try {
      for (const build of chosen()) {
        const current = build.tags ?? [];
        const next = mode === "add"
          ? normalizeTags([...current, tag])
          : current.filter((item) => item.toLowerCase() !== tag.toLowerCase());
        if (next.length === current.length && next.every((item, index) => item === current[index])) continue;
        await patchBuildMeta(getToken, build.slug, { tags: next });
        changed += 1;
      }
      toast.success(mode === "add" ? `Tagged ${changed} build${changed === 1 ? "" : "s"} “${tag}”` : `Removed “${tag}” from ${changed} build${changed === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error("Couldn’t update tags", { description: errorText(err) });
    } finally {
      setBulkBusy(false);
      refresh();
    }
  };

  const bulkDelete = async () => {
    setBulkBusy(true);
    const deleted: Deleted[] = [];
    try {
      for (const build of chosen()) {
        await apiCall(getToken, buildPath(build.slug), { method: "DELETE" });
        deleted.push(build);
      }
    } catch (err) {
      toast.error("Some builds couldn’t be deleted", { description: errorText(err) });
    } finally {
      setBulkBusy(false);
      setConfirmDelete(false);
      setSelected(new Set());
      refresh();
      announceDeleted(deleted);
    }
  };

  const runBulk = async (action: BulkAction) => {
    if (action === "delete") {
      setConfirmDelete(true);
      return;
    }
    setBulkBusy(true);
    try {
      if (action === "randomizer") await addToRandomizer(chosen());
      if (action === "export") await exportBuilds(selected);
      if (action === "publish" || action === "unpublish") await bulkPublication(chosen(), action === "publish");
    } finally {
      setBulkBusy(false);
      if (action === "publish" || action === "unpublish") refresh();
    }
  };

  const restoreFromTrash = async (slug: string, name: string) => {
    await undoDelete([{ slug, name }]);
  };

  const toggle = (slug: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    return next;
  });

  /** Per-card props: selection, the extra kebab entries and the author update. */
  const cardProps = (build: CustomBuild) => {
    const version = versionBySlug.get(build.forkedFrom?.communitySlug ?? "");
    const updated = version && authorUpdated(build.forkedFrom, version) ? version : null;
    const extras: KebabExtra[] = [
      { key: "pin", label: build.pinned ? "Unpin" : "Pin to top", icon: build.pinned ? <PinOff className="h-4 w-4" aria-hidden /> : <Pin className="h-4 w-4" aria-hidden />, onClick: () => void setPinned(build, !build.pinned) },
      { key: "randomizer", label: "Add to randomizer pool", icon: <Dices className="h-4 w-4" aria-hidden />, onClick: () => void addToRandomizer([build]) },
      { key: "share", label: "Copy share code", icon: <Share2 className="h-4 w-4" aria-hidden />, onClick: () => void copyShareCode(build) },
    ];
    return {
      selection: selecting ? { selected: selected.has(build.slug), onToggle: toggle } : undefined,
      extraMenuItems: extras,
      authorUpdate: updated ? { onReview: () => setReview({ build, version: updated.version }) } : undefined,
    };
  };

  const toolbar = (
    <div role="group" aria-label="Library tools" className="flex flex-wrap gap-2">
      <Button variant="ghost" size="sm" aria-pressed={selecting} iconLeft={<ListChecks className="h-4 w-4" aria-hidden />} onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>
        {selecting ? "Done selecting" : "Select"}
      </Button>
      <Button variant="ghost" size="sm" iconLeft={<Upload className="h-4 w-4" aria-hidden />} onClick={() => setImportSource("")}>Import</Button>
      <Button variant="ghost" size="sm" iconLeft={<Download className="h-4 w-4" aria-hidden />} onClick={() => void exportBuilds()}>Export</Button>
      <Button variant="ghost" size="sm" iconLeft={<Trash2 className="h-4 w-4" aria-hidden />} onClick={() => setTrashOpen(true)}>
        Recently deleted ({trash.data?.total ?? 0})
      </Button>
    </div>
  );

  const overlays = (
    <>
      {selecting ? (
        <BuildBulkBar
          count={selected.size}
          pageCount={items.length}
          busy={bulkBusy}
          onSelectAll={() => setSelected(new Set(items.map((build) => build.slug)))}
          onClear={() => setSelected(new Set())}
          onDone={() => { setSelecting(false); setSelected(new Set()); }}
          onTag={(tag, mode) => void bulkTag(tag, mode)}
          onAction={(action) => void runBulk(action)}
        />
      ) : null}
      {trashOpen ? (
        <RecentlyDeletedDrawer
          open={trashOpen}
          trash={trash.data}
          loading={trash.isLoading}
          error={!!trash.error}
          onRetry={() => void trash.mutate()}
          onClose={() => setTrashOpen(false)}
          onRestore={restoreFromTrash}
        />
      ) : null}
      {importSource !== null ? (
        <ImportBuildsDialog
          open
          initialSource={importSource}
          onClose={() => setImportSource(null)}
          onImported={(summary) => { toast.success(summary); refresh(); }}
        />
      ) : null}
      {review ? (
        <ReviewUpdateModal
          open
          build={review.build}
          version={review.version}
          onClose={() => setReview(null)}
          onDone={(message, failed) => {
            if (failed) toast.error("Couldn’t update the build", { description: message });
            else toast.success(message);
            void versions.mutate();
            refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => (bulkBusy ? undefined : setConfirmDelete(false))}
        onConfirm={() => void bulkDelete()}
        intent="danger"
        loading={bulkBusy}
        title={`Delete ${selected.size} build${selected.size === 1 ? "" : "s"}?`}
        description="They move to Recently deleted for 30 days. Published ones lose their Community listing."
        confirmLabel="Delete builds"
      />
    </>
  );

  return { toolbar, overlays, cardProps, announceDeleted, openImport: setImportSource };
}

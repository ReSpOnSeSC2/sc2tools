"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import {
  ArrowLeft,
  Eye,
  Library,
  LineChart,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";
import {
  coerceRace,
  matchupLabel,
  raceIconName,
  raceTint,
  type VsRace,
} from "@/lib/race";
import { BuildDossier } from "./BuildDossier";
import { BuildEditorSheet } from "./BuildEditorSheet";
import { BuildPublishModal } from "./BuildPublishModal";
import type { CustomBuild } from "./types";

export interface BuildDetailViewProps {
  slug: string;
}

/** Outer wrapper providing a toast context for the inner panel. */
export function BuildDetailView(props: BuildDetailViewProps) {
  return (
    <ToastProvider>
      <BuildDetailInner {...props} />
    </ToastProvider>
  );
}

function BuildDetailInner({ slug }: BuildDetailViewProps) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const buildSwr = useApi<CustomBuild>(
    `/v1/custom-builds/${encodeURIComponent(slug)}`,
  );
  // The dossier surface fetches `/v1/custom-builds/:slug/matches` —
  // same shape as the analyzer modal and the new `<BuildDossier />`.
  const dossierPath = buildSwr.data
    ? `/v1/custom-builds/${encodeURIComponent(slug)}/matches`
    : null;

  const [editorOpen, setEditorOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  const handleSaved = useCallback(
    async (saved: CustomBuild) => {
      toast.success(`Saved “${saved.name}”.`);
      await buildSwr.mutate();
    },
    [toast, buildSwr],
  );

  const handleDelete = useCallback(async () => {
    setDeletePending(true);
    try {
      await apiCall<void>(
        getToken,
        `/v1/custom-builds/${encodeURIComponent(slug)}`,
        { method: "DELETE" },
      );
      toast.success("Build deleted.");
      window.location.assign("/builds");
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Delete failed.";
      toast.error("Couldn’t delete build", { description: message });
      setDeletePending(false);
      setDeleteOpen(false);
    }
  }, [slug, toast, getToken]);

  if (buildSwr.error?.status === 404) {
    return <NotFoundView slug={slug} />;
  }

  if (!buildSwr.data) {
    return <Skeleton rows={6} />;
  }

  const build = buildSwr.data;
  const race = coerceRace(build.race);
  const tint = raceTint(race);
  const mu = matchupLabel(race, (build.vsRace as VsRace) ?? "Any");
  const fromOpponent = build.perspective === "opponent";

  return (
    <div className="space-y-6">
      <Link
        href="/builds"
        className="inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to library
      </Link>

      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-2">
            <Icon name={raceIconName(race)} kind="race" size={14} decorative />
            <span>{mu}</span>
            {fromOpponent ? (
              <Badge size="sm" variant="cyan" iconLeft={<Eye className="h-3 w-3" aria-hidden />}>
                From opponent
              </Badge>
            ) : null}
            {build.isPublic ? (
              <Badge size="sm" variant="accent">
                Published
              </Badge>
            ) : null}
          </span>
        }
        title={build.name || "Untitled build"}
        description={build.description}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/snapshots?build=${encodeURIComponent(build.name || "")}&matchup=${encodeURIComponent(racePairToMatchup(build.race, build.vsRace))}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 text-caption font-semibold text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              <LineChart className="h-4 w-4" aria-hidden />
              View Snapshot Analysis
            </Link>
            <Button
              variant="secondary"
              onClick={() => setEditorOpen(true)}
              iconLeft={<Pencil className="h-4 w-4" aria-hidden />}
            >
              Edit
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPublishOpen(true)}
              iconLeft={<Send className="h-4 w-4" aria-hidden />}
            >
              {build.isPublic ? "Update community" : "Publish"}
            </Button>
            <Button
              variant="danger"
              onClick={() => setDeleteOpen(true)}
              iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}
            >
              Delete
            </Button>
          </div>
        }
      />

      {dossierPath ? (
        <BuildDossier
          apiPath={dossierPath}
          headerSlot={() => <NotesPanel notes={build.notes} accent={tint.text} />}
        />
      ) : null}

      <BuildEditorSheet
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        build={build}
        onSaved={handleSaved}
      />
      <BuildPublishModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        build={build}
        onPublished={async () => {
          await buildSwr.mutate();
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => (deletePending ? undefined : setDeleteOpen(false))}
        onConfirm={handleDelete}
        intent="danger"
        loading={deletePending}
        title="Delete this build?"
        description={`“${build.name}” will be removed from your library on every signed-in device.`}
        confirmLabel="Delete build"
      />
    </div>
  );
}

function racePairToMatchup(
  race: string | null | undefined,
  vsRace: string | null | undefined,
): string {
  const my = String(race || "?").trim().charAt(0).toUpperCase();
  const opp = String(vsRace || "?").trim().charAt(0).toUpperCase();
  if (!"PTZ".includes(my) || !"PTZ".includes(opp)) return "PvZ";
  return `${my}v${opp}`;
}

function NotesPanel({
  notes,
  accent,
}: {
  notes?: string;
  accent: string;
}) {
  if (!notes || !notes.trim()) {
    return (
      <Card title="Personal notes">
        <p className="text-caption text-text-muted">
          No notes yet. Use the Edit button to capture scouting tells, transitions,
          or punishment timings — they stay private to your account.
        </p>
      </Card>
    );
  }
  return (
    <Card title="Personal notes">
      <pre
        className={["whitespace-pre-wrap break-words font-sans text-body", accent].join(" ")}
      >
        {notes}
      </pre>
    </Card>
  );
}

function NotFoundView({ slug }: { slug: string }) {
  return (
    <div className="space-y-6">
      <Link
        href="/builds"
        className="inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to library
      </Link>
      <Card>
        <EmptyState
          title="Build not found"
          sub={`No build matched the slug “${slug}”. It may have been deleted on another device.`}
        />
        <div className="mt-3 flex justify-center">
          <Link
            href="/builds"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-border bg-bg-elevated px-4 text-body font-semibold text-text transition-colors hover:border-border-strong hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <Library className="h-4 w-4" aria-hidden />
            Back to library
          </Link>
        </div>
      </Card>
    </div>
  );
}

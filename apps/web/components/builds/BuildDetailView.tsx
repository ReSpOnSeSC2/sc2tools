"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import {
  ArrowLeft,
  Eye,
  Library,
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
import { RequestError } from "@/components/ui/RequestError";
import { useToast } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import {
  coerceRace,
  matchupLabel,
  raceIconName,
  raceTint,
  type VsRace,
} from "@/lib/race";
import { BuildDossier } from "./BuildDossier";
import { BuildDefinitionCard } from "./BuildDefinitionCard";
import { EditCustomBuildLauncher } from "./EditCustomBuildLauncher";
import { BuildPublishModal } from "./BuildPublishModal";
import { BuildSignInPrompt } from "./BuildSignInPrompt";
import type { CustomBuild } from "./types";

const BACK_LINK_CLASS =
  "inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text";

/**
 * The tab title once the build has loaded (the server title is generic),
 * before the site name the root template adds.
 *
 * Example: `buildDocumentTitle("Proxy Gateway")` → "Proxy Gateway · Custom build".
 */
export function buildDocumentTitle(name: string): string {
  return `${name} · Custom build`;
}

export interface BuildDetailViewProps {
  slug: string;
}

/**
 * Toast context comes from the app-wide provider in the root layout.
 *
 * Auth is settled first: while signed out useApi has no key, so the
 * build request never starts and the skeleton below would never clear.
 * While Clerk loads, the page explains that custom builds need an account.
 * A signed-out visitor is asked to sign in and comes back here afterwards.
 */
export function BuildDetailView(props: BuildDetailViewProps) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded || !isSignedIn) return <BuildSignInPrompt slug={props.slug} />;
  return <BuildDetailInner {...props} />;
}

function BuildDetailInner({ slug }: BuildDetailViewProps) {
  const { getToken } = useAuth();
  const router = useRouter();
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
  const [editorFocus, setEditorFocus] = useState<"notes" | "preview" | undefined>();
  const [publishOpen, setPublishOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  // The server title is generic (and noindex): build names are private.
  // "Proxy Gateway · Custom build · SC2 Tools", like every other tab title.
  const loadedName = buildSwr.data?.name?.trim();
  useDocumentTitle(loadedName ? buildDocumentTitle(loadedName) : null);

  const handleSaved = useCallback(
    async (_saved: CustomBuild) => {
      await buildSwr.mutate();
    },
    [buildSwr],
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
      // Client navigation keeps the app shell (and its toast) mounted.
      router.push("/builds");
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Delete failed.";
      toast.error("Couldn’t delete build", { description: message });
      setDeletePending(false);
      setDeleteOpen(false);
    }
  }, [slug, toast, getToken, router]);

  if (buildSwr.error?.status === 404) {
    return <NotFoundView slug={slug} />;
  }

  if (!buildSwr.data && buildSwr.error) {
    return (
      <div className="space-y-6">
        <Link href="/builds" className={BACK_LINK_CLASS}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to library
        </Link>
        <RequestError
          title="Couldn’t load this build"
          error={buildSwr.error}
          onRetry={() => buildSwr.mutate()}
        />
      </div>
    );
  }

  if (!buildSwr.data) {
    return <Skeleton rows={6} />;
  }

  const build = buildSwr.data;
  const race = coerceRace(build.race);
  const tint = raceTint(race);
  const mu = matchupLabel(race, (build.vsRace as VsRace) ?? "Any");
  const fromOpponent = build.perspective === "opponent";
  const openEditor = (focus?: "notes" | "preview") => { setEditorFocus(focus); setEditorOpen(true); };

  return (
    <div className="space-y-6">
      <Link href="/builds" className={BACK_LINK_CLASS}>
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
            <Button
              variant="secondary"
              onClick={() => openEditor()}
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
          phasePerspective={
            build.perspective === "opponent" ? "opponent" : undefined
          }
          headerSlot={() => <div className="grid min-w-0 gap-4 lg:grid-cols-2"><BuildDefinitionCard build={build} onEdit={() => openEditor()} /><NotesPanel notes={build.notes} accent={tint.text} onEdit={() => openEditor("notes")} /></div>}
        />
      ) : null}

        <EditCustomBuildLauncher
          build={editorOpen ? build : null}
          initialFocus={editorFocus}
          onClose={() => setEditorOpen(false)}
          onSaved={async (saved) => {
            await handleSaved(saved);
            setEditorOpen(false);
          }}
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

function NotesPanel({
  notes,
  accent,
  onEdit,
}: {
  notes?: string;
  accent: string;
  onEdit: () => void;
}) {
  if (!notes || !notes.trim()) {
    return (
      <Card title="Personal notes">
        <p className="text-caption text-text-muted">
          No notes yet. <button type="button" onClick={onEdit} className="font-semibold text-accent underline">Edit the build</button> to capture scouting tells, transitions,
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
      <Link href="/builds" className={BACK_LINK_CLASS}>
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
            className="inline-flex min-h-[44px] items-center gap-2 hard-press rounded-full border-2 border-line bg-bg-surface px-5 font-display text-body font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <Library className="h-4 w-4" aria-hidden />
            Back to library
          </Link>
        </div>
      </Card>
    </div>
  );
}

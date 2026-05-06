"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ExternalLink, Pencil, Send, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import {
  coerceRace,
  matchupLabel,
  raceIconName,
  type VsRace,
} from "@/lib/race";
import { BuildDossier } from "./BuildDossier";
import type { CustomBuild } from "./types";

/**
 * Modal opened from the `/builds` (Custom builds) card grid. Renders
 * the same `<BuildDossier />` surface as the analyzer modal and the
 * standalone `/builds/[slug]` route, so a card click stays on the
 * library page instead of full-page navigating away.
 *
 * Notes are read-only here (the BuildEditorSheet remains the canonical
 * editor for them — wired through the Edit button); Publish reuses the
 * existing publish modal opened by the parent `BuildsLibrary`.
 */
export function BuildDossierModal({
  build,
  onClose,
  onEdit,
  onPublish,
  onDelete,
}: {
  build: CustomBuild;
  onClose: () => void;
  onEdit: (slug: string) => void;
  onPublish: (slug: string) => void;
  onDelete: (slug: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const race = coerceRace(build.race);
  const mu = matchupLabel(race, (build.vsRace as VsRace) ?? "Any");
  const apiPath = `/v1/custom-builds/${encodeURIComponent(build.slug)}/matches`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${build.name || "Build"} dossier`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <Card padded>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="inline-flex items-center gap-2 text-caption text-text-muted">
                <Icon
                  name={raceIconName(race)}
                  kind="race"
                  size={14}
                  decorative
                />
                <span>{mu}</span>
                {build.perspective === "opponent" ? (
                  <Badge size="sm" variant="cyan">
                    From opponent
                  </Badge>
                ) : null}
                {build.isPublic ? (
                  <Badge size="sm" variant="accent">
                    Published
                  </Badge>
                ) : null}
              </div>
              <h2 className="truncate text-h3 font-semibold text-text">
                {build.name || "Untitled build"}
              </h2>
              {build.description ? (
                <p className="text-caption text-text-muted">
                  {build.description}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onEdit(build.slug)}
                iconLeft={<Pencil className="h-4 w-4" aria-hidden />}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onPublish(build.slug)}
                iconLeft={<Send className="h-4 w-4" aria-hidden />}
              >
                {build.isPublic ? "Update" : "Publish"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => onDelete(build.slug)}
                iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}
              >
                Delete
              </Button>
              <Link
                href={`/builds/${encodeURIComponent(build.slug)}`}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-caption text-text-muted hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                title="Open the full-page view"
                onClick={onClose}
              >
                Full page
                <ExternalLink className="h-3 w-3" aria-hidden />
              </Link>
              <button
                type="button"
                aria-label="Close build dossier"
                onClick={onClose}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
        </Card>

        <BuildDossier
          apiPath={apiPath}
          headerSlot={() => (
            <NotesPanel notes={build.notes} onEdit={() => onEdit(build.slug)} />
          )}
        />
      </div>
    </div>
  );
}

function NotesPanel({
  notes,
  onEdit,
}: {
  notes?: string;
  onEdit: () => void;
}) {
  if (!notes || !notes.trim()) {
    return (
      <Card title="Personal notes">
        <p className="text-caption text-text-muted">
          No notes yet.{" "}
          <button
            type="button"
            onClick={onEdit}
            className="font-medium text-accent hover:underline"
          >
            Edit the build
          </button>{" "}
          to capture scouting tells or transitions — they stay private to
          your account.
        </p>
      </Card>
    );
  }
  return (
    <Card title="Personal notes">
      <pre className="whitespace-pre-wrap break-words font-sans text-body text-text">
        {notes}
      </pre>
    </Card>
  );
}

"use client";

import { ExternalLink, Pencil, Send, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import {
  coerceRace,
  matchupLabel,
  raceIconName,
  type VsRace,
} from "@/lib/race";
import { BuildDossier } from "./BuildDossier";
import { BuildDefinitionCard } from "./BuildDefinitionCard";
import { BuildKebab } from "./BuildCard";
import { PracticeButton } from "@/components/practice/PracticeButton";
import type { CustomBuild } from "./types";

/**
 * Modal opened from the `/builds` (Build library) card grid. Renders
 * the same `<BuildDossier />` surface as the analyzer modal and the
 * standalone `/builds/[slug]` route, so a card click stays on the
 * library page instead of full-page navigating away.
 *
 * Notes are read-only here; their edit action opens the shared rich
 * editor focused on private notes. Publish reuses the
 * existing publish modal opened by the parent `BuildsLibrary`.
 */
export function BuildDossierModal({
  build,
  onClose,
  onEdit,
  onPublish,
  onDelete,
  onDuplicate,
  onReclassify,
  onChanged,
}: {
  build: CustomBuild;
  onClose: () => void;
  onEdit: (slug: string, initialFocus?: "notes" | "preview") => void;
  onPublish: (slug: string) => void;
  onDelete: (slug: string) => void;
  onDuplicate?: (slug: string) => void;
  onReclassify?: (slug: string) => void;
  onChanged?: () => void | Promise<unknown>;
}) {
  const race = coerceRace(build.race);
  const mu = matchupLabel(race, (build.vsRace as VsRace) ?? "Any");
  const apiPath = `/v1/custom-builds/${encodeURIComponent(build.slug)}/matches`;

  return (
    <Modal open size="xl" title={`${build.name || "Build"} dossier`} onClose={onClose}>
      <div className="space-y-4">
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
              {build.description ? (
                <p className="text-caption text-text-muted">
                  {build.description}
                </p>
              ) : null}
            </div>
            {/* Edit · Publish · Full page · Delete, destructive last; every action is a 44 px target. */}
            <div className="flex flex-wrap items-center gap-2">
              <PracticeButton build={build} privateBuild />
              <Button
                size="sm"
                variant="secondary"
                className="min-h-11"
                onClick={() => onEdit(build.slug)}
                iconLeft={<Pencil className="h-4 w-4" aria-hidden />}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="min-h-11"
                onClick={() => onPublish(build.slug)}
                iconLeft={<Send className="h-4 w-4" aria-hidden />}
              >
                {build.isPublic ? "Update listing" : "Publish…"}
              </Button>
              <LinkButton
                href={`/builds/${encodeURIComponent(build.slug)}`}
                size="sm"
                variant="ghost"
                className="min-h-11"
                title="Open the full-page view"
                onClick={onClose}
                iconRight={<ExternalLink className="h-3.5 w-3.5" aria-hidden />}
              >
                Full page
              </LinkButton>
              <Button
                size="sm"
                variant="danger"
                className="min-h-11"
                onClick={() => onDelete(build.slug)}
                iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}
              >
                Delete
              </Button>
              <BuildKebab slug={build.slug} name={build.name} isPublic={!!build.isPublic} onEdit={onEdit} onPublish={onPublish} onDelete={onDelete} onDuplicate={onDuplicate} onReclassify={onReclassify} onChanged={onChanged} />
            </div>
          </div>
        </Card>

        <BuildDossier
          apiPath={apiPath}
          slug={build.slug}
          onEditRules={() => onEdit(build.slug, "preview")}
          phasePerspective={
            build.perspective === "opponent" ? "opponent" : undefined
          }
          headerSlot={() => (
            <div className="grid min-w-0 gap-4 lg:grid-cols-2"><BuildDefinitionCard build={build} onEdit={() => onEdit(build.slug)} /><NotesPanel notes={build.notes} onEdit={() => onEdit(build.slug, "notes")} /></div>
          )}
        />
      </div>
    </Modal>
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

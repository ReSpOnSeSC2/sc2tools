"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { BuildEditorModal } from "@/components/builds/editor";
import {
  RACE_OPTIONS,
  VS_RACE_OPTIONS,
  SKILL_LEVELS,
  type BuildEditorDraft,
  type BuildRule,
  type RaceLite,
  type SkillLevelId,
  type VsRaceLite,
} from "@/lib/build-rules";
import type { BuildOrderEvent } from "@/lib/build-events";
import type { CustomBuild } from "./types";

export interface EditCustomBuildLauncherProps {
  /** Build the user clicked Edit on. Modal is shown when this is non-null. */
  build: CustomBuild | null;
  onClose: () => void;
  onSaved: (saved: CustomBuild) => void;
}

interface SavedBuildDoc extends Record<string, unknown> {
  slug: string;
  name?: string;
  description?: string;
  race?: string;
  vsRace?: string;
  skillLevel?: string | null;
  shareWithCommunity?: boolean;
  isPublic?: boolean;
  rules?: BuildRule[];
  winConditions?: string[];
  losesTo?: string[];
  transitionsInto?: string[];
  sourceGameId?: string;
  sourceReplayId?: string;
  perspective?: "you" | "opponent";
}

const RACE_SET = new Set<string>(RACE_OPTIONS);
const VS_RACE_SET = new Set<string>(VS_RACE_OPTIONS);
const SKILL_SET = new Set<string>(SKILL_LEVELS.map((l) => l.id));

function coerceRace(value: unknown): RaceLite {
  if (typeof value === "string" && RACE_SET.has(value)) return value as RaceLite;
  return "Protoss";
}

function coerceVsRace(value: unknown): VsRaceLite {
  if (typeof value === "string" && VS_RACE_SET.has(value)) return value as VsRaceLite;
  return "Any";
}

function coerceSkillLevel(value: unknown): SkillLevelId | null {
  if (typeof value === "string" && SKILL_SET.has(value)) return value as SkillLevelId;
  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function toRules(value: unknown): BuildRule[] {
  if (!Array.isArray(value)) return [];
  // The persisted document has already been validated server-side, so we
  // trust it here and let the editor's sanitiser flag anything stale.
  return value as BuildRule[];
}

function toInitialDraft(doc: SavedBuildDoc): Partial<BuildEditorDraft> {
  const sourceReplayId =
    typeof doc.sourceReplayId === "string"
      ? doc.sourceReplayId
      : typeof doc.sourceGameId === "string"
        ? doc.sourceGameId
        : undefined;
  return {
    name: typeof doc.name === "string" ? doc.name : "",
    description: typeof doc.description === "string" ? doc.description : "",
    race: coerceRace(doc.race),
    vsRace: coerceVsRace(doc.vsRace),
    skillLevel: coerceSkillLevel(doc.skillLevel),
    shareWithCommunity:
      typeof doc.shareWithCommunity === "boolean"
        ? doc.shareWithCommunity
        : !!doc.isPublic,
    winConditions: toStringArray(doc.winConditions),
    losesTo: toStringArray(doc.losesTo),
    transitionsInto: toStringArray(doc.transitionsInto),
    rules: toRules(doc.rules),
    sourceReplayId,
  };
}

/**
 * EditCustomBuildLauncher — fetches the full saved-build document for
 * the row the user clicked Edit on, then opens the rich BuildEditorModal
 * pre-populated with rules, "Recommended for", strategy notes, and the
 * existing slug locked so renames update the same document.
 *
 * The source-replay events column will be empty in the editor (we don't
 * round-trip the original replay), but rules, custom rules, and all
 * metadata fields remain fully editable.
 */
export function EditCustomBuildLauncher({
  build,
  onClose,
  onSaved,
}: EditCustomBuildLauncherProps) {
  const { getToken } = useAuth();
  const [doc, setDoc] = useState<SavedBuildDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const slug = build?.slug ?? null;

  useEffect(() => {
    if (!slug) {
      setDoc(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setDoc(null);
    (async () => {
      try {
        const fetched = await apiCall<SavedBuildDoc>(
          getToken,
          `/v1/custom-builds/${encodeURIComponent(slug)}`,
        );
        if (cancelled) return;
        setDoc(fetched);
      } catch (err) {
        if (cancelled) return;
        const message =
          (err as ClientApiError | undefined)?.message ??
          "Couldn't load this build for editing.";
        setLoadError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, getToken]);

  const initialDraft = useMemo(
    () => (doc ? toInitialDraft(doc) : null),
    [doc],
  );

  const open = !!build;
  if (!open) return null;

  if (loading || !doc || !initialDraft) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-busy="true"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
        onClick={onClose}
      >
        <div
          className="rounded-lg border border-border bg-bg-surface px-4 py-3 text-caption text-text-muted shadow-[var(--shadow-card)]"
          onClick={(e) => e.stopPropagation()}
        >
          {loadError ? (
            <span className="text-danger">{loadError}</span>
          ) : (
            "Loading build…"
          )}
        </div>
      </div>
    );
  }

  // No source replay events at edit time — the original .SC2Replay
  // isn't round-tripped through the saved doc. The rules column still
  // works (custom rules + edit existing) so name / metadata / "Recommended
  // for" / strategy notes are all editable.
  const events: ReadonlyArray<BuildOrderEvent> = [];

  return (
    <BuildEditorModal
      open
      onClose={onClose}
      mode="edit"
      lockedSlug={doc.slug}
      events={events}
      gameId={initialDraft.sourceReplayId}
      race={initialDraft.race ?? "Protoss"}
      vsRace={initialDraft.vsRace ?? "Any"}
      perspective={doc.perspective === "opponent" ? "opponent" : "you"}
      defaultName={initialDraft.name}
      initialDraft={initialDraft}
      onSaved={(savedSlug, draft) => {
        const saved: CustomBuild = {
          ...(build as CustomBuild),
          slug: savedSlug,
          name: draft.name,
          race: draft.race,
          vsRace: draft.vsRace,
          description: draft.description || undefined,
          isPublic: draft.shareWithCommunity,
          updatedAt: new Date().toISOString(),
        };
        onSaved(saved);
      }}
    />
  );
}

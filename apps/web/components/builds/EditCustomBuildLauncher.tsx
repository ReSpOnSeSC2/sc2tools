"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { readReferenceBuildOrder } from "@/lib/buildOrderReference";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useOwnerRequestScope, type ClientApiError } from "@/lib/clientApi";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { BuildEditorModal } from "@/components/builds/editor";
import type { BuildEditorSaveResult } from "@/components/builds/editor/BuildEditor.types";
import {
  RACE_OPTIONS,
  VS_RACE_OPTIONS,
  SKILL_LEVELS,
  isProxyStructureToken,
  NAME_MAX_CHARS,
  type BuildEditorDraft,
  type BuildRule,
  type RaceLite,
  type SkillLevelId,
  type VsRaceLite,
} from "@/lib/build-rules";
import {
  humanizeBuildName,
  normalizeBuildName,
  rulesToSignature,
  type BuildOrderEvent,
  type BuildSignatureItem,
} from "@/lib/build-events";
import type { CustomBuild } from "./types";

export interface EditCustomBuildLauncherProps {
  /** Build the user clicked Edit on. Modal is shown when this is non-null. */
  build: CustomBuild | null;
  onClose: () => void;
  onSaved: (saved: CustomBuild, result: BuildEditorSaveResult) => void;
  initialFocus?: "notes" | "preview";
  intent?: "edit" | "duplicate";
}

interface SavedBuildDoc extends Record<string, unknown> {
  slug: string;
  name?: string;
  description?: string;
  notes?: string;
  race?: string;
  vsRace?: string;
  skillLevel?: string | null;
  shareWithCommunity?: boolean;
  isPublic?: boolean;
  communityAuthorName?: string;
  publishAnonymously?: boolean;
  rules?: BuildRule[];
  signature?: BuildSignatureItem[];
  winConditions?: string[];
  losesTo?: string[];
  transitionsInto?: string[];
  sourceGameId?: string;
  sourceReplayId?: string;
  perspective?: "you" | "opponent";
}

interface OwnerPublicationSettings {
  published: boolean;
  authorName: string;
  publishAnonymously: boolean;
  mirrorPending: boolean;
}

const RACE_SET = new Set<string>(RACE_OPTIONS);
const VS_RACE_SET = new Set<string>(VS_RACE_OPTIONS);
const SKILL_SET = new Set<string>(SKILL_LEVELS.map((l) => l.id));

export function duplicateBuildName(name: string): string {
  const match = /\s+\(copy(?: (\d+))?\)$/i.exec(name.trim());
  const base = (match ? name.trim().slice(0, match.index) : name.trim()) || "Untitled build";
  const copyNumber = match ? Math.min(999999, Number(match[1] || 1) + 1) : 1;
  const suffix = copyNumber === 1 ? " (copy)" : ` (copy ${copyNumber})`;
  return `${base.slice(0, NAME_MAX_CHARS - suffix.length).trimEnd()}${suffix}`;
}

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

function toInitialDraft(
  doc: SavedBuildDoc,
  publication: OwnerPublicationSettings | null,
): Partial<BuildEditorDraft> {
  const sourceReplayId =
    typeof doc.sourceReplayId === "string"
      ? doc.sourceReplayId
      : typeof doc.sourceGameId === "string"
        ? doc.sourceGameId
        : undefined;
  return {
    ...(readReferenceBuildOrder(doc.buildOrder) ? { buildOrder: readReferenceBuildOrder(doc.buildOrder)! } : {}),
    name: typeof doc.name === "string" ? doc.name : "",
    description: typeof doc.description === "string" ? doc.description : "",
    notes: typeof doc.notes === "string" ? doc.notes : "",
    race: coerceRace(doc.race),
    vsRace: coerceVsRace(doc.vsRace),
    skillLevel: coerceSkillLevel(doc.skillLevel),
    // Community is authoritative. The owner-only endpoint also performs
    // read repair when the private badge mirror was interrupted, so always
    // prefer its visibility over the potentially stale private document.
    shareWithCommunity:
      publication?.published ??
      (typeof doc.isPublic === "boolean"
        ? doc.isPublic
        : !!doc.shareWithCommunity),
    communityAuthorName:
      publication?.authorName ??
      (typeof doc.communityAuthorName === "string"
        ? doc.communityAuthorName
        : ""),
    publishAnonymously:
      publication?.publishAnonymously ?? !!doc.publishAnonymously,
    winConditions: toStringArray(doc.winConditions),
    losesTo: toStringArray(doc.losesTo),
    transitionsInto: toStringArray(doc.transitionsInto),
    rules: toRules(doc.rules),
    sourceReplayId,
  };
}

/**
 * Reconstruct source-timeline events for the editor from the saved doc.
 *
 * The original .SC2Replay isn't round-tripped, so we synthesise events
 * from what the doc carries:
 *   1. v3 `rules` — preferred: rule names ARE the canonical tokens
 *      (BuildStargate, ResearchBlink), so the timeline rows map back
 *      to rules exactly and render as "In rules".
 *   2. legacy `signature` — fallback for older docs / community forks
 *      saved before rules were copied. Unit names are icon-ish
 *      (lowercase) so we re-derive display + category via
 *      normalizeBuildName; tokens are best-effort.
 */
export function docToEvents(doc: SavedBuildDoc): BuildOrderEvent[] {
  const fromRules = rulesToSignature(
    Array.isArray(doc.rules) ? doc.rules : [],
  );
  if (fromRules.length > 0) {
    return fromRules.map((item) => {
      const isBuilding = isProxyStructureToken(item.unit);
      return {
        time: Math.max(0, Math.floor(item.beforeSec)),
        // Already a canonical Build/Train/Research/Morph token —
        // spaEventToWhat passes it through unchanged.
        name: item.unit,
        display: humanizeBuildName(item.unit) || item.unit,
        category: isBuilding ? "building" : undefined,
        is_building: isBuilding,
        is_proxy: item.proxy === true,
      };
    });
  }
  const signature = Array.isArray(doc.signature) ? doc.signature : [];
  const events: BuildOrderEvent[] = [];
  for (const item of signature) {
    const rawName = String(item?.unit ?? "").trim();
    if (!rawName) continue;
    const { displayName, category } = normalizeBuildName(rawName);
    const token = (displayName || rawName).replace(/[^A-Za-z0-9]/g, "");
    if (!token) continue;
    const count = Math.max(1, Math.floor(Number(item.count) || 1));
    events.push({
      time: Math.max(0, Math.floor(Number(item.beforeSec) || 0)),
      name: token,
      display: count > 1 ? `${displayName} ×${count}` : displayName,
      category,
      is_building: category === "building",
      is_proxy: item.proxy === true,
    });
  }
  events.sort((a, b) => a.time - b.time);
  return events;
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
  initialFocus,
  intent = "edit",
}: EditCustomBuildLauncherProps) {
  const { getToken, userId, isLoaded, isSignedIn } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const runOwned = useOwnerRequestScope(owner, getToken);
  const runner = useRef(runOwned); runner.current = runOwned;
  const slug = build?.slug ?? null;
  const scope = useMemo(() => ({ owner, slug, intent, authReady: isLoaded }), [owner, slug, intent, isLoaded]);
  const current = useRef(scope); current.current = scope;
  const mounted = useRef(true);
  const active = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    scope: typeof scope; attempt: number; doc: SavedBuildDoc | null;
    publication: OwnerPublicationSettings | null; error: string | null; loading: boolean;
  } | null>(null);
  const visible = loaded && loaded.scope === scope && loaded.attempt === attempt ? loaded : null;
  const doc = visible?.doc ?? null;
  const publication = visible?.publication ?? null;
  const loadError = visible?.error ?? null;
  const loading = !visible || visible.loading;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);

  useEffect(() => {
    const requestOwner = scope.owner;
    if (!scope.slug) return;
    const empty = { scope, attempt, doc: null, publication: null };
    if (!requestOwner) {
      setLoaded({ ...empty, loading: !scope.authReady, error: scope.authReady ? "Sign in to load this build." : null });
      return;
    }
    const controller = new AbortController(); active.current = controller;
    const request = runner.current;
    let cancelled = false;
    setLoaded({ ...empty, loading: true, error: null });
    (async () => {
      try {
        const result = await request(requestOwner, async (scopedToken, signal, assertCurrent) => {
          const peers = new AbortController();
          const abortPeers = () => peers.abort(signal.reason);
          if (signal.aborted) abortPeers();
          else signal.addEventListener("abort", abortPeers, { once: true });
          try {
            const [fetched, publicationSettings] = await Promise.all([
              apiCall<SavedBuildDoc>(scopedToken, `/v1/custom-builds/${encodeURIComponent(scope.slug!)}`, { signal: peers.signal }),
              scope.intent === "duplicate" ? Promise.resolve({ published: false, authorName: "", publishAnonymously: false, mirrorPending: false })
                : apiCall<OwnerPublicationSettings>(scopedToken, `/v1/community/my-build-publication/${encodeURIComponent(scope.slug!)}`, { signal: peers.signal }),
            ]);
            assertCurrent();
            return { doc: fetched, publication: publicationSettings };
          } finally {
            peers.abort(); signal.removeEventListener("abort", abortPeers);
          }
        }, 20_000, controller.signal);
        if (cancelled || current.current !== scope || controller.signal.aborted) return;
        setLoaded({ scope, attempt, ...result, loading: false, error: null });
      } catch (err) {
        if (cancelled || current.current !== scope || controller.signal.aborted) return;
        const message =
          (err as ClientApiError | undefined)?.message ??
          "Couldn't load this build for editing.";
        setLoaded({ ...empty, loading: false, error: message });
      } finally {
        if (active.current === controller) active.current = null;
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (active.current === controller) active.current = null;
    };
  }, [scope, attempt, getToken]);

  const initialDraft = useMemo(
    () => {
      if (!doc) return null;
      const draft = toInitialDraft(doc, publication);
      return intent === "duplicate" ? { ...draft, name: duplicateBuildName(draft.name || ""), shareWithCommunity: false } : draft;
    },
    [doc, publication, intent],
  );

  // Source-timeline events synthesised from the saved doc (rules first,
  // legacy signature as fallback) — see docToEvents above.
  const events = useMemo<ReadonlyArray<BuildOrderEvent>>(
    () => (doc ? docToEvents(doc) : []),
    [doc],
  );

  const open = !!build;
  if (!open) return null;
  const close = () => {
    if (!mounted.current || current.current !== scope) return;
    active.current?.abort(); onClose();
  };

  if (loading || !doc || !publication || !initialDraft) {
    const pending = !loadError;
    return (
      <Modal open size="xl" title={intent === "duplicate" ? "Duplicate build" : "Edit build"} onClose={close}
        footer={loadError ? <Button onClick={() => { active.current?.abort(); setAttempt(value => value + 1); }} disabled={!owner}>Retry</Button> : undefined}>
        <div aria-busy={pending} className="text-caption text-text-muted">
          {loadError ? <p role="alert" className="text-danger">{loadError}</p> : <p role="status">Loading build…</p>}
        </div>
      </Modal>
    );
  }

  return (
    <BuildEditorModal
      open
      onClose={close}
      mode={intent === "duplicate" ? "create" : "edit"}
      lockedSlug={intent === "duplicate" ? undefined : doc.slug}
      createOnly={intent === "duplicate"}
      saveIntent={intent === "duplicate" ? "duplicate" : undefined}
      sourceSignature={intent === "duplicate" ? doc.signature : undefined}
      timelineFromSavedBuild
      initialFocus={initialFocus}
      legacySignature={!doc.rules?.length && !!doc.signature?.length}
      events={events}
      gameId={initialDraft.sourceReplayId}
      race={initialDraft.race ?? "Protoss"}
      vsRace={initialDraft.vsRace ?? "Any"}
      perspective={doc.perspective === "opponent" ? "opponent" : "you"}
      defaultName={initialDraft.name}
      initialDraft={initialDraft}
      onSaved={(savedSlug, draft, result) => {
        if (!mounted.current || current.current !== scope) return;
        const saved: CustomBuild = {
          ...(build as CustomBuild),
          slug: savedSlug,
          name: draft.name,
          race: draft.race,
          vsRace: draft.vsRace,
          description: draft.description || undefined,
          notes: draft.notes.trim(),
          rules: draft.rules,
          skillLevel: draft.skillLevel,
          winConditions: draft.winConditions,
          losesTo: draft.losesTo,
          transitionsInto: draft.transitionsInto,
          isPublic: result.communityError
            ? (result.communityPublished ?? publication.published)
            : draft.shareWithCommunity,
          communityAuthorName: draft.communityAuthorName,
          publishAnonymously: draft.publishAnonymously,
          updatedAt: new Date().toISOString(),
        };
        onSaved(saved, result);
      }}
    />
  );
}

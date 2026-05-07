"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import {
  PREVIEW_DEBOUNCE_MS,
  RULES_MAX_PER_BUILD,
  cycleRuleType,
  defaultRuleFor,
  ruleFromEvent,
  sanitiseDraft,
  slugifyRuleName,
  type BuildEditorDraft,
  type BuildEditorErrors,
  type BuildRule,
} from "@/lib/build-rules";
import type { BuildOrderEvent } from "@/lib/build-events";
import type {
  BuildEditorContext,
  BuildEditorPreviewResult,
  BuildEditorState,
  BuildEditorToast,
  BuildEditorToastKind,
} from "./BuildEditor.types";

const TOAST_TTL_MS = 6000;

export interface UseBuildEditorStateOptions {
  open: boolean;
  context: BuildEditorContext;
  initialDraft: BuildEditorDraft;
  /**
   * When set, save() PUTs to this slug regardless of the current name,
   * preserving the existing build's identity through renames. Used by
   * the edit-existing-build flow.
   */
  lockedSlug?: string;
  /** Notified after a successful save with the persisted slug + payload. */
  onSaved?: (slug: string, payload: BuildEditorDraft) => void;
  /**
   * Demo mode (landing-page replay preview). The editor is fully
   * interactive but skips authenticated network calls: the
   * preview-matches fetch is suppressed (the user has no library to
   * match against), inline inspect is a no-op, and save() bails out
   * with a sign-up nudge instead of PUTing to the API.
   */
  demoMode?: boolean;
}

interface BuildOrderApiResp {
  events?: BuildOrderEvent[];
  opp_events?: BuildOrderEvent[];
}

interface ReclassifyResponseSummary {
  tagged?: number;
  cleared?: number;
  matched?: number;
  scanned?: number;
  ruleCount?: number;
}

interface SaveBuildResponse {
  ok: boolean;
  reclassify: ReclassifyResponseSummary | null;
}

/**
 * useBuildEditorState — owns draft state, debounced preview fetch,
 * inspect cache, toasts, and the save flow. Returns a single object
 * the orchestrator and section components consume.
 */
export function useBuildEditorState(
  opts: UseBuildEditorStateOptions,
): BuildEditorState {
  const { open, context, initialDraft, lockedSlug, onSaved, demoMode } = opts;
  const { getToken } = useAuth();

  const [draft, setDraft] = useState<BuildEditorDraft>(initialDraft);
  const [errors, setErrors] = useState<BuildEditorErrors>({});
  const [preview, setPreview] = useState<BuildEditorPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPage, setPreviewPage] = useState(0);
  const [almostPage, setAlmostPage] = useState(0);

  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);
  const [hiddenMatchIds, setHiddenMatchIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [inspectCache, setInspectCache] = useState<
    Record<string, BuildOrderEvent[]>
  >({});
  const [inspectLoading, setInspectLoading] = useState<
    Record<string, boolean>
  >({});

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [toasts, setToasts] = useState<BuildEditorToast[]>([]);

  const pristineRef = useRef<string>(JSON.stringify(initialDraft));

  // Reset state every time the modal opens with a new context.
  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft);
    setErrors({});
    setPreview(null);
    setPreviewError(null);
    setPreviewPage(0);
    setAlmostPage(0);
    setExpandedMatchId(null);
    setHiddenMatchIds(new Set());
    setInspectCache({});
    setInspectLoading({});
    setSaving(false);
    setSaveError(null);
    setSavedOk(false);
    pristineRef.current = JSON.stringify(initialDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Debounced preview fetch.
  useEffect(() => {
    if (!open) return;
    if (demoMode) {
      // Demo (landing page): no signed-in library to match against, so
      // we render an empty preview without firing the auth'd request.
      setPreview({
        matches: [],
        almost_matches: [],
        scanned_games: 0,
        truncated: false,
      });
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    if (draft.rules.length === 0) {
      setPreview({
        matches: [],
        almost_matches: [],
        scanned_games: 0,
        truncated: false,
      });
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setPreviewError(null);
    setPreviewLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const result = await apiCall<BuildEditorPreviewResult>(
          getToken,
          "/v1/custom-builds/preview-matches",
          {
            method: "POST",
            body: JSON.stringify({
              rules: draft.rules,
              race: draft.race,
              vsRace: draft.vsRace,
              perspective: context.perspective === "opponent" ? "opponent" : "you",
            }),
          },
        );
        if (cancelled) return;
        setPreview(result);
        setPreviewLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        setPreviewLoading(false);
        setPreviewError(extractMessage(err) || "Preview failed.");
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, demoMode, draft.rules, draft.race, draft.vsRace, context.perspective, getToken]);

  // Reset pagination when preview changes.
  useEffect(() => {
    setPreviewPage(0);
    setAlmostPage(0);
  }, [preview]);

  /* ---- Toast helpers --------------------------------------------- */
  const dismissToast = useCallback((id: string) => {
    setToasts((xs) => xs.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (
      kind: BuildEditorToastKind,
      text: string,
      action?: BuildEditorToast["action"],
    ) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((xs) => [...xs, { id, kind, text, action }]);
      window.setTimeout(() => dismissToast(id), TOAST_TTL_MS);
    },
    [dismissToast],
  );

  /* ---- Rule mutators --------------------------------------------- */
  const updateRule = useCallback(
    (idx: number, patch: Partial<BuildRule>) => {
      setDraft((d) => {
        const next = d.rules.slice();
        const cur = next[idx];
        if (!cur) return d;
        next[idx] = { ...cur, ...patch } as BuildRule;
        return { ...d, rules: next };
      });
    },
    [],
  );

  const removeRule = useCallback((idx: number) => {
    setDraft((d) => ({
      ...d,
      rules: d.rules.filter((_, i) => i !== idx),
    }));
  }, []);

  const cycleRule = useCallback((idx: number) => {
    setDraft((d) => {
      const next = d.rules.slice();
      const cur = next[idx];
      if (!cur) return d;
      next[idx] = cycleRuleType(cur);
      return { ...d, rules: next };
    });
  }, []);

  const addRuleFromEvent = useCallback(
    (ev: {
      time: number;
      name: string;
      is_building?: boolean;
      race?: string;
      category?: string;
    }) => {
      setDraft((d) => {
        if (d.rules.length >= RULES_MAX_PER_BUILD) {
          pushToast("warn", `Rule cap reached (${RULES_MAX_PER_BUILD}).`);
          return d;
        }
        const r = ruleFromEvent(ev);
        if (!r) return d;
        if (d.rules.some((existing) => existing.name === r.name)) {
          pushToast("warn", `${r.name} is already in your rules.`);
          return d;
        }
        return { ...d, rules: [...d.rules, r] };
      });
    },
    [pushToast],
  );

  const addCustomRule = useCallback(
    (type: BuildRule["type"]) => {
      setDraft((d) => {
        if (d.rules.length >= RULES_MAX_PER_BUILD) {
          pushToast("warn", `Rule cap reached (${RULES_MAX_PER_BUILD}).`);
          return d;
        }
        const blank = defaultRuleFor(type, "", 60, 1);
        return { ...d, rules: [...d.rules, blank] };
      });
    },
    [pushToast],
  );

  /* ---- Inspect cache --------------------------------------------- */
  const toggleInspect = useCallback(
    (gameId: string) => {
      if (!gameId) return;
      // Demo mode has no preview matches to inspect, so this is a
      // no-op. We keep the callback identity stable to avoid effect
      // churn in BuildEditorPreview.
      if (demoMode) return;
      setExpandedMatchId((cur) => (cur === gameId ? null : gameId));
      if (inspectCache[gameId] || inspectLoading[gameId]) return;
      setInspectLoading((p) => ({ ...p, [gameId]: true }));
      (async () => {
        try {
          const resp = await apiCall<BuildOrderApiResp>(
            getToken,
            `/v1/games/${encodeURIComponent(gameId)}/build-order`,
          );
          setInspectCache((p) => ({
            ...p,
            [gameId]: Array.isArray(resp.events) ? resp.events : [],
          }));
        } catch {
          /* leave cache empty; row renders "No events available." */
        } finally {
          setInspectLoading((p) => {
            const n = { ...p };
            delete n[gameId];
            return n;
          });
        }
      })();
    },
    [demoMode, getToken, inspectCache, inspectLoading],
  );

  const hideMatch = useCallback((gameId: string) => {
    if (!gameId) return;
    setHiddenMatchIds((prev) => {
      const n = new Set(prev);
      n.add(gameId);
      return n;
    });
    setExpandedMatchId((cur) => (cur === gameId ? null : cur));
  }, []);

  const unhideAll = useCallback(() => {
    setHiddenMatchIds(new Set());
  }, []);

  /* ---- Dirty tracking + save ------------------------------------- */
  const isDirty = useMemo(
    () => JSON.stringify(draft) !== pristineRef.current,
    [draft],
  );

  const save = useCallback(
    async (andReclassify: boolean) => {
      const sanitised = sanitiseDraft(draft);
      if (!sanitised.ok) {
        setErrors(sanitised.errors);
        pushToast("error", "Fix the highlighted fields before saving.");
        return;
      }
      setErrors({});
      if (demoMode) {
        // Landing-page demo: surface a sign-up nudge and bail before
        // we hit the auth'd endpoint. The save bar still routes the
        // visitor toward /sign-up via its own button, but a stray
        // form-submit (Enter in a text field) lands here too.
        pushToast(
          "warn",
          "Sign up to save this build to your library.",
          { label: "Sign up", href: "/sign-up" },
        );
        return;
      }
      setSaving(true);
      setSaveError(null);
      const slug = lockedSlug || slugifyRuleName(sanitised.payload.name);
      const body = {
        name: sanitised.payload.name,
        race: sanitised.payload.race,
        vsRace: sanitised.payload.vsRace,
        description: sanitised.payload.description,
        rules: sanitised.payload.rules,
        skillLevel: sanitised.payload.skillLevel,
        winConditions: sanitised.payload.winConditions,
        losesTo: sanitised.payload.losesTo,
        transitionsInto: sanitised.payload.transitionsInto,
        shareWithCommunity: sanitised.payload.shareWithCommunity,
        sourceGameId:
          sanitised.payload.sourceReplayId || context.gameId || undefined,
        perspective: context.perspective === "opponent" ? "opponent" : "you",
        schemaVersion: 3,
      };
      try {
        const resp = await apiCall<SaveBuildResponse | null>(
          getToken,
          `/v1/custom-builds/${encodeURIComponent(slug)}`,
          {
            method: "PUT",
            body: JSON.stringify(body),
          },
        );
        pristineRef.current = JSON.stringify(draft);
        setSaving(false);
        setSavedOk(true);
        pushToast(
          "success",
          `Saved "${sanitised.payload.name}".`,
          { label: "View build", href: `/builds/${slug}` },
        );
        // Server now reclassifies cloud-side on every save so the stored
        // game.myBuild stays in sync with the saved rules. Surface the
        // counts when present (when perGame is wired) so the user knows
        // their opponent profile / Recent games view will reflect the
        // build name immediately. The `andReclassify` flag is preserved
        // for backwards-compat with the "Save & Reclassify" button but no
        // longer changes server behavior.
        const summary = describeReclassifySummary(resp?.reclassify);
        if (summary) pushToast("success", summary);
        else if (andReclassify) {
          pushToast("success", "Saved — no games matched yet.");
        }
        onSaved?.(slug, draft);
      } catch (err: unknown) {
        setSaving(false);
        const message = extractMessage(err) || "Save failed.";
        setSaveError(message);
        pushToast("error", `Save failed: ${message}`);
      }
    },
    [draft, context.gameId, context.perspective, demoMode, getToken, lockedSlug, onSaved, pushToast],
  );

  return {
    draft,
    setDraft,
    errors,
    preview,
    previewLoading,
    previewError,
    previewPage,
    almostPage,
    setPreviewPage,
    setAlmostPage,
    expandedMatchId,
    toggleInspect,
    hiddenMatchIds,
    hideMatch,
    unhideAll,
    inspectCache,
    inspectLoading,
    saving,
    saveError,
    savedOk,
    updateRule,
    removeRule,
    cycleRule,
    addRuleFromEvent,
    addCustomRule,
    isDirty,
    save,
    toasts,
    pushToast,
    dismissToast,
  };
}

/**
 * Format the reclassify summary block from the PUT /custom-builds/:slug
 * response into a one-line toast. Returns null when there's nothing
 * worth saying (no tags moved AND no matches AND no rules), so the
 * caller can fall back to a generic "saved" message.
 */
function describeReclassifySummary(
  r: ReclassifyResponseSummary | null | undefined,
): string | null {
  if (!r) return null;
  const tagged = r.tagged ?? 0;
  const cleared = r.cleared ?? 0;
  const matched = r.matched ?? 0;
  if (tagged > 0 || cleared > 0) {
    const parts: string[] = [];
    if (tagged > 0) {
      parts.push(`Tagged ${tagged} game${tagged === 1 ? "" : "s"}`);
    }
    if (cleared > 0) {
      parts.push(
        `cleared ${cleared} stale tag${cleared === 1 ? "" : "s"}`,
      );
    }
    return parts.join(" · ");
  }
  if (matched > 0) {
    return `Matched ${matched} game${matched === 1 ? "" : "s"} — already tagged.`;
  }
  return null;
}

function extractMessage(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") {
    // Older callers passed JSON envelopes through here; strip them.
    return humanizeIfJsonEnvelope(err);
  }
  if (typeof err === "object" && err && "message" in err) {
    const raw = String((err as { message: unknown }).message);
    return humanizeIfJsonEnvelope(raw);
  }
  return null;
}

function humanizeIfJsonEnvelope(s: string): string {
  // Last-line defense: if a raw JSON envelope ever leaks through,
  // collapse it to the inner message so we never render `{"error":...}`
  // verbatim to users.
  const trimmed = s.trim();
  if (trimmed[0] !== "{") return s;
  try {
    const obj = JSON.parse(trimmed) as unknown;
    const e =
      obj && typeof obj === "object"
        ? (obj as { error?: { message?: unknown; code?: unknown } }).error
        : undefined;
    if (e && typeof e === "object") {
      const m = typeof e.message === "string" ? e.message : "";
      const c = typeof e.code === "string" ? e.code : "";
      if (m && m !== "internal_error") return m;
      if (c) return c;
    }
  } catch {
    /* not JSON — fall through */
  }
  return s;
}

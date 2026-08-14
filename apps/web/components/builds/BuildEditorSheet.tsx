"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Toggle } from "@/components/ui/Toggle";
import { apiCall } from "@/lib/clientApi";
import { useMyDisplayName } from "@/lib/useMyDisplayName";
import { useToast } from "@/components/ui/Toast";
import { slugifyBuildName, type BuildSignatureItem } from "@/lib/build-events";
import {
  RACES,
  VS_RACES,
  type Race,
  type VsRace,
} from "@/lib/race";
import type { CustomBuild } from "./types";

export interface BuildEditorSheetProps {
  open: boolean;
  onClose: () => void;
  /** When set, edits an existing build. When null, creates a new one. */
  build: CustomBuild | null;
  onSaved: (build: CustomBuild) => void;
}

interface EditableSignatureRow extends BuildSignatureItem {
  rowKey: string;
}

interface OwnerPublicationSettings {
  published: boolean;
  authorName: string;
  publishAnonymously: boolean;
  mirrorPending: boolean;
}

const DEFAULT_RACE: Race = "Protoss";
const DEFAULT_VS_RACE: VsRace = "Any";

function makeRowKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function fromBuild(build: CustomBuild | null): {
  name: string;
  race: Race;
  vsRace: VsRace;
  description: string;
  notes: string;
  isPublic: boolean;
  communityAuthorName: string;
  publishAnonymously: boolean;
  signature: EditableSignatureRow[];
} {
  return {
    name: build?.name ?? "",
    race: build?.race ?? DEFAULT_RACE,
    vsRace: (build?.vsRace as VsRace) ?? DEFAULT_VS_RACE,
    description: build?.description ?? "",
    notes: build?.notes ?? "",
    isPublic: !!build?.isPublic,
    communityAuthorName: build?.communityAuthorName ?? "",
    publishAnonymously: !!build?.publishAnonymously,
    signature: (build?.signature ?? []).map((s) => ({
      ...s,
      rowKey: makeRowKey(),
    })),
  };
}

function formatBeforeSec(sec: number): string {
  const safe = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function parseBeforeSec(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return 0;
  if (trimmed.includes(":")) {
    const [m, s] = trimmed.split(":");
    const mn = Number(m);
    const sn = Number(s);
    if (Number.isFinite(mn) && Number.isFinite(sn)) {
      return Math.max(0, Math.round(mn * 60 + sn));
    }
  }
  const n = Number(trimmed);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  return null;
}

/**
 * BuildEditorSheet — create / edit dialog for a custom build.
 *
 * Renders:
 *   - Basics (name, race, vs race, description, notes)
 *   - Public toggle (publish-to-community handled by a separate flow)
 *   - Editable signature row list (time / unit / count) with add/remove
 *   - Sticky save bar with safe-area padding on mobile
 *
 * Persists via PUT /v1/custom-builds/:slug. The slug is derived from
 * the name on first save and never changes after.
 */
export function BuildEditorSheet({
  open,
  onClose,
  build,
  onSaved,
}: BuildEditorSheetProps) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const profileDisplayName = useMyDisplayName();
  const isEdit = !!build;
  const [state, setState] = useState(() => fromBuild(build));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityUnavailable, setIdentityUnavailable] = useState(false);
  const [authoritativePublished, setAuthoritativePublished] = useState(
    !!build?.isPublic,
  );
  const formId = useId();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState(fromBuild(build));
    setError(null);
    setSaving(false);
    setIdentityUnavailable(false);
    setIdentityLoading(!!build);
    setAuthoritativePublished(!!build?.isPublic);
    if (build) {
      void apiCall<OwnerPublicationSettings>(
        getToken,
        `/v1/community/my-build-publication/${encodeURIComponent(build.slug)}`,
      )
        .then((settings) => {
          if (cancelled) return;
          setState((current) => ({
            ...current,
            isPublic: settings.published,
            communityAuthorName: settings.authorName || "",
            publishAnonymously: settings.publishAnonymously,
          }));
          setAuthoritativePublished(settings.published);
        })
        .catch(() => {
          if (cancelled) return;
          setIdentityUnavailable(true);
          setError(
            "Couldn't load the current Community author setting. Close this editor and try again before changing a published build.",
          );
        })
        .finally(() => {
          if (!cancelled) setIdentityLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
    // A parent SWR refresh may replace the build object while this sheet is
    // open. The source slug is the stable editor identity; object identity is
    // not a reason to erase inline partial-success/error state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, build?.slug, getToken]);

  useEffect(() => {
    if (!open || !profileDisplayName) return;
    setState((current) =>
      current.communityAuthorName
        ? current
        : {
            ...current,
            communityAuthorName: profileDisplayName.slice(0, 80),
          },
    );
  }, [open, profileDisplayName]);

  const slugPreview = useMemo(() => {
    if (build?.slug) return build.slug;
    return slugifyBuildName(state.name) || "";
  }, [build?.slug, state.name]);

  function update<K extends keyof typeof state>(
    key: K,
    next: (typeof state)[K],
  ) {
    setState((s) => ({ ...s, [key]: next }));
  }

  function addRow() {
    setState((s) => ({
      ...s,
      signature: [
        ...s.signature,
        {
          rowKey: makeRowKey(),
          unit: "",
          count: 1,
          beforeSec:
            s.signature.length > 0
              ? Math.min(
                  1800,
                  (s.signature[s.signature.length - 1].beforeSec ?? 0) + 30,
                )
              : 60,
        },
      ],
    }));
  }

  function updateRow(rowKey: string, patch: Partial<EditableSignatureRow>) {
    setState((s) => ({
      ...s,
      signature: s.signature.map((r) =>
        r.rowKey === rowKey ? { ...r, ...patch } : r,
      ),
    }));
  }

  function removeRow(rowKey: string) {
    setState((s) => ({
      ...s,
      signature: s.signature.filter((r) => r.rowKey !== rowKey),
    }));
  }

  async function handleSave() {
    if (saving) return;
    setError(null);
    const trimmedName = state.name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (build && (identityLoading || identityUnavailable)) {
      setError(
        "Wait for the current Community author setting to load, then try again.",
      );
      return;
    }
    if (
      state.isPublic &&
      !state.publishAnonymously &&
      !state.communityAuthorName.trim()
    ) {
      setError("Enter the public author name, or choose Post anonymously.");
      return;
    }
    const slug = build?.slug || slugifyBuildName(trimmedName);
    if (!slug) {
      setError("Pick a name with at least one letter or number.");
      return;
    }
    const cleanSignature: BuildSignatureItem[] = state.signature
      .filter((r) => r.unit.trim().length > 0)
      .map((r) => ({
        unit: r.unit.trim().slice(0, 80),
        count: Math.max(1, Math.min(200, Math.round(Number(r.count) || 1))),
        beforeSec: Math.max(
          0,
          Math.min(24 * 60 * 60, Math.round(Number(r.beforeSec) || 0)),
        ),
      }));
    const payload: Partial<CustomBuild> & { slug: string; name: string; race: Race } = {
      slug,
      name: trimmedName,
      race: state.race,
      vsRace: state.vsRace,
      description: state.description.trim().slice(0, 4000) || undefined,
      notes: state.notes.trim().slice(0, 8000) || undefined,
      isPublic: state.isPublic,
      communityAuthorName: state.communityAuthorName.trim().slice(0, 80),
      publishAnonymously: state.publishAnonymously,
      signature: cleanSignature,
      perspective: build?.perspective,
      sourceGameId: build?.sourceGameId,
      opponentRace: build?.opponentRace,
    };
    setSaving(true);
    try {
      const result = await apiCall<{
        community?: {
          action?: "published" | "updated" | "unpublished";
          error?: string;
          mirrorPending?: boolean;
        } | null;
      }>(getToken, `/v1/custom-builds/${encodeURIComponent(slug)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      let repairedSettings: OwnerPublicationSettings | null = null;
      if (result?.community?.mirrorPending || result?.community?.error) {
        try {
          repairedSettings = await apiCall<OwnerPublicationSettings>(
            getToken,
            `/v1/community/my-build-publication/${encodeURIComponent(slug)}`,
          );
        } catch {
          // Community already has the requested state. Keep the durable
          // warning below because only the private-library badge may lag.
        }
      }
      const actualIsPublic = result?.community?.error
        ? (repairedSettings?.published ?? authoritativePublished)
        : state.isPublic;
      if (repairedSettings) {
        setAuthoritativePublished(repairedSettings.published);
      }
      const saved: CustomBuild = {
        ...(build ?? {}),
        ...payload,
        isPublic: actualIsPublic,
        signature: cleanSignature,
        updatedAt: new Date().toISOString(),
      };
      onSaved(saved);
      if (result?.community?.error) {
        setState((current) => ({ ...current, isPublic: actualIsPublic }));
        const visibilityChangeVerified =
          !!repairedSettings &&
          authoritativePublished !== state.isPublic &&
          repairedSettings.published === state.isPublic;
        if (visibilityChangeVerified) {
          setError(null);
          toast.warning(
            state.isPublic
              ? "Build saved; Community listing is live"
              : "Build saved; Community listing was removed",
            {
              description:
                "Current Community visibility was verified even though the original confirmation was interrupted.",
            },
          );
          onClose();
        } else if (actualIsPublic && !state.isPublic) {
          setError(
            "Build saved, but removal from Community failed. The existing listing is still public. Try again.",
          );
          toast.error("Build saved; Community listing is still public", {
            description:
              "Removal failed, so the existing listing remains visible. Try again.",
          });
        } else if (state.isPublic) {
          setError(
            result.community.error === "public_author_name_required"
              ? "Build saved; the Community listing wasn't updated. Add a public name or choose Post anonymously, then save again."
              : "Build saved, but the Community listing could not be updated. Try again.",
          );
          toast.error("Build saved; Community listing wasn't updated", {
            description:
              result.community.error === "public_author_name_required"
                ? "Add a public name or explicitly choose Post anonymously, then save again."
                : "Your prior Community visibility is unchanged. Try the update again.",
          });
        } else {
          setError(
            "Build saved, but Community removal could not be confirmed. Reopen the editor to check the current listing.",
          );
          toast.error("Build saved; Community removal wasn't confirmed", {
            description:
              "Reopen the editor to load the current authoritative visibility before trying again.",
          });
        }
        return;
      }
      setAuthoritativePublished(state.isPublic);
      if (
        result?.community?.mirrorPending &&
        (!repairedSettings || repairedSettings.mirrorPending)
      ) {
        toast.warning("Community change is live; library badge is syncing", {
          description:
            "The listing already has the requested state. Reopen the editor to retry the library badge sync.",
        });
      }
      onClose();
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Save failed.";
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={saving ? () => undefined : onClose}
      title={isEdit ? "Edit build" : "New build"}
      description={
        isEdit
          ? "Update steps, notes, and visibility. Saved changes sync across every device."
          : "Capture an opener: name, matchup, and the timing rhythm you play."
      }
      size="xl"
      hideClose={saving}
      disableScrimClose={saving}
      footer={
        <ModalActions className="w-full justify-end">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={saving}
            type="button"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={identityLoading}
            type="submit"
            form={formId}
          >
            {isEdit ? "Save changes" : "Create build"}
          </Button>
        </ModalActions>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
        className="space-y-5"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" required htmlFor="be-name">
            <Input
              id="be-name"
              value={state.name}
              onChange={(e) => update("name", e.target.value)}
              maxLength={120}
              placeholder="e.g. Glaive Adept Timing"
              autoFocus={!isEdit}
            />
          </Field>
          <Field
            label="Slug"
            hint={isEdit ? "Slug is fixed once a build is created." : "Auto-generated from the name."}
            htmlFor="be-slug"
          >
            <Input
              id="be-slug"
              value={slugPreview}
              disabled
              className="font-mono"
            />
          </Field>
          <Field label="Race" required htmlFor="be-race">
            <Select
              id="be-race"
              value={state.race}
              onChange={(e) => update("race", e.target.value as Race)}
            >
              {RACES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Versus race" htmlFor="be-vs">
            <Select
              id="be-vs"
              value={state.vsRace}
              onChange={(e) => update("vsRace", e.target.value as VsRace)}
            >
              {VS_RACES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Description" hint="Public summary, shown when you publish." htmlFor="be-desc">
          <textarea
            id="be-desc"
            value={state.description}
            onChange={(e) => update("description", e.target.value)}
            rows={3}
            maxLength={4000}
            className="block w-full rounded-lg border border-border bg-bg-elevated p-3 text-body text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
            placeholder="What makes this opener distinct? What does it punish?"
          />
        </Field>
        <Field
          label="Personal notes"
          hint="Private to you — scouting tells, transition cues, alarms."
          htmlFor="be-notes"
        >
          <textarea
            id="be-notes"
            value={state.notes}
            onChange={(e) => update("notes", e.target.value)}
            rows={4}
            maxLength={8000}
            className="block w-full rounded-lg border border-border bg-bg-elevated p-3 text-body text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
            placeholder="If they take their natural before 4:00, switch to the punishing variant."
          />
        </Field>
        <SignatureEditor
          rows={state.signature}
          onAdd={addRow}
          onUpdate={updateRow}
          onRemove={removeRow}
        />
        <label className="flex items-start gap-3 rounded-lg border border-border bg-bg-elevated/50 p-3">
          <Toggle
            checked={state.isPublic}
            onChange={(next) => update("isPublic", next)}
            label={state.isPublic ? "Shared with Community" : "Private build"}
          />
          <span className="text-caption text-text-muted">
            <span className="font-medium text-text">Share with Community</span>
            <span className="block">
              Publishes this build when you save. Turn it off and save to
              remove the Community listing while keeping your private build.
            </span>
          </span>
        </label>
        {state.isPublic ? (
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-bg-elevated/40 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            {identityLoading ? (
              <div
                role="status"
                aria-live="polite"
                className="text-caption text-text-muted sm:col-span-2"
              >
                Loading your current Community author settingâ€¦
              </div>
            ) : null}
            <Field
              label="Name shown publicly"
              hint={
                state.publishAnonymously
                  ? "Hidden while Post anonymously is selected."
                  : "Your profile name is used by default."
              }
            >
              <Input
                value={state.communityAuthorName}
                onChange={(e) => update("communityAuthorName", e.target.value)}
                maxLength={80}
                disabled={
                  state.publishAnonymously ||
                  identityLoading ||
                  identityUnavailable
                }
                placeholder="Your community handle"
              />
            </Field>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2">
              <input
                type="checkbox"
                checked={state.publishAnonymously}
                onChange={(e) => update("publishAnonymously", e.target.checked)}
                disabled={identityLoading || identityUnavailable}
                className="h-4 w-4 accent-accent-cyan"
              />
              <span className="text-caption font-medium text-text">
                Post anonymously
              </span>
            </label>
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-danger"
          >
            {error}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

function SignatureEditor({
  rows,
  onAdd,
  onUpdate,
  onRemove,
}: {
  rows: EditableSignatureRow[];
  onAdd: () => void;
  onUpdate: (rowKey: string, patch: Partial<EditableSignatureRow>) => void;
  onRemove: (rowKey: string) => void;
}) {
  return (
    <section
      aria-label="Build steps"
      className="space-y-2 rounded-lg border border-border bg-bg-elevated/30 p-3"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          Build steps
        </h3>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          iconLeft={<Plus className="h-4 w-4" aria-hidden />}
          onClick={onAdd}
        >
          Add step
        </Button>
      </header>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-caption text-text-muted">
          No steps yet. Add timings (e.g. <code>2:30 Stargate</code>) so the
          classifier can recognise this build.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <SignatureRow
              key={row.rowKey}
              row={row}
              onChange={(patch) => onUpdate(row.rowKey, patch)}
              onRemove={() => onRemove(row.rowKey)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SignatureRow({
  row,
  onChange,
  onRemove,
}: {
  row: EditableSignatureRow;
  onChange: (patch: Partial<EditableSignatureRow>) => void;
  onRemove: () => void;
}) {
  const [timeText, setTimeText] = useState(formatBeforeSec(row.beforeSec));

  useEffect(() => {
    setTimeText(formatBeforeSec(row.beforeSec));
  }, [row.beforeSec]);

  return (
    <li className="grid grid-cols-12 items-center gap-2 rounded-md border border-border bg-bg-surface p-2">
      <label className="col-span-3 sm:col-span-2 text-caption text-text-muted">
        <span className="sr-only">Time</span>
        <Input
          inputSize="sm"
          value={timeText}
          onChange={(e) => setTimeText(e.target.value)}
          onBlur={() => {
            const parsed = parseBeforeSec(timeText);
            if (parsed != null) onChange({ beforeSec: parsed });
            else setTimeText(formatBeforeSec(row.beforeSec));
          }}
          className="font-mono tabular-nums"
          inputMode="numeric"
          aria-label="Step time"
          placeholder="0:00"
        />
      </label>
      <label className="col-span-7 sm:col-span-7 min-w-0 text-caption text-text-muted">
        <span className="sr-only">Unit or building</span>
        <Input
          inputSize="sm"
          value={row.unit}
          onChange={(e) => onChange({ unit: e.target.value })}
          placeholder="e.g. Stargate, Stalker, Blink"
          aria-label="Step unit"
        />
      </label>
      <label className="col-span-2 sm:col-span-2 text-caption text-text-muted">
        <span className="sr-only">Count</span>
        <Input
          inputSize="sm"
          type="number"
          min={1}
          max={200}
          value={row.count}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange({ count: Math.max(1, Math.min(200, n)) });
          }}
          className="text-right font-mono tabular-nums"
          aria-label="Step count"
        />
      </label>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove step"
        className="col-span-12 sm:col-span-1 inline-flex h-9 items-center justify-center rounded-md border border-border bg-bg-elevated text-text-muted hover:border-danger/40 hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );
}

"use client";

import { DockInput, DockSelect, DockButton } from "./DockControls";

import { useEffect, useRef, useState } from "react";
import { BuildProfileChart } from "@/components/overlay/widgets/BuildProfileWidget";
import type { DockPost } from "./dockActions";
import { DockSnapshotState } from "./useDockPanelActions";
import {
  BUILD_PROFILE_AXES,
  isBuildProfileComplete,
  type StudioBuildProfile,
  type StudioBuildProfileRatings,
  type StudioState,
} from "@/lib/multichat/useStudioState";

function copyProfile(profile: StudioBuildProfile): StudioBuildProfile {
  return { ...profile, ratings: { ...profile.ratings }, labels: { ...profile.labels } };
}

/** The same manual editor serves the OBS Dock and authenticated site Settings. */
export function BuildProfileEditor({
  profile,
  busy,
  ready = true,
  onPost,
}: {
  profile: StudioBuildProfile;
  busy: boolean;
  ready?: boolean;
  /** null means no authoritative save response; keep the user's draft. */
  onPost: DockPost;
}) {
  const [draft, setDraft] = useState(() => copyProfile(profile));
  const [dirty, setDirty] = useState(false);
  // Set synchronously before React commits: a poll in the same beat cannot
  // overwrite the first keystroke or selection.
  const dirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!dirtyRef.current) setDraft(copyProfile(profile));
  }, [profile, dirty]);

  const edit = (next: StudioBuildProfile) => {
    dirtyRef.current = true;
    setDirty(true);
    setNotice(null);
    setDraft(next);
  };
  const editRating = (key: keyof StudioBuildProfileRatings, value: string) => {
    edit({ ...draft, ratings: { ...draft.ratings, [key]: value ? Number(value) : null } });
  };
  const disabled = busy || saving || !ready;
  const draftComplete = isBuildProfileComplete(draft);
  const savedComplete = isBuildProfileComplete(profile);
  const draftValid = draft.title.trim().length <= 80 && BUILD_PROFILE_AXES.every(({ key }) => {
    const label = draft.labels[key].trim();
    const rating = draft.ratings[key];
    return label.length > 0 && label.length <= 32
      && (rating === null || (Number.isInteger(rating) && rating >= 1 && rating <= 5));
  });
  // Hidden profiles can be saved in progress or cleared. A visible graph
  // must remain complete; Hide first before removing its title or a score.
  const canSave = draftValid && (!profile.visible || draftComplete);
  const saveRef = useRef<() => Promise<StudioState | null>>(async () => null);
  const visibilityRef = useRef<(visible: boolean) => Promise<StudioState | null>>(async () => null);

  const save = async () => {
    if (disabled || !canSave) return null;
    setSaving(true);
    setNotice(null);
    try {
      // Visibility is its own control: editing never auto-shows the widget.
      const saved = await onPost({
        buildProfile: {
          title: draft.title.trim(),
          ratings: { ...draft.ratings },
          labels: Object.fromEntries(BUILD_PROFILE_AXES.map(({ key }) => [key, draft.labels[key].trim()])),
        },
      }, () => saveRef.current());
      if (saved) {
        setDraft(copyProfile(saved.buildProfile));
        dirtyRef.current = false;
        setDirty(false);
        setNotice("Ratings saved.");
      }
      return saved;
    } finally {
      setSaving(false);
    }
  };

  const setVisible = async (visible: boolean) => {
    if (disabled || (visible && (!savedComplete || dirty))) return null;
    setSaving(true);
    setNotice(null);
    try {
      const saved = await onPost({ buildProfile: { visible } }, () => visibilityRef.current(visible));
      if (saved) setNotice(saved.buildProfile.visible ? "Widget shown." : "Widget hidden.");
      return saved;
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;
  visibilityRef.current = setVisible;

  const discard = () => {
    dirtyRef.current = false;
    setDirty(false);
    setDraft(copyProfile(profile));
    setNotice(null);
  };

  if (!ready) return <DockSnapshotState />;

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-text-muted">Personal ratings · 1–5</p>
        <span className={`rounded-full border px-2 py-0.5 text-micro font-semibold ${profile.visible ? "border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan" : "border-border text-text-muted"}`}>
          {profile.visible ? "Shown" : "Hidden"}
        </span>
      </div>
      {!ready ? <p className="text-caption text-text-muted">Waiting for saved ratings…</p> : null}
      <label className="block space-y-1">
        <span className="text-caption font-medium text-text">Build title</span>
        <DockInput
          type="text"
          value={draft.title}
          onChange={(event) => edit({ ...draft, title: event.target.value })}
          placeholder="Name of this video's build"
          maxLength={80}
          disabled={disabled}
          className="w-full min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-caption text-text placeholder:text-text-muted focus:border-accent-cyan disabled:opacity-50"
        />
      </label>
      <div className="space-y-2">
        <p className="text-micro text-text-muted">Edit the wording and select each rating.</p>
        {BUILD_PROFILE_AXES.map((axis) => (
          <div key={axis.key} className="flex min-w-0 items-center justify-between gap-2">
            <DockInput
              type="text"
              aria-label={`${axis.label} label`}
              value={draft.labels[axis.key]}
              onChange={(event) => edit({ ...draft, labels: { ...draft.labels, [axis.key]: event.target.value } })}
              maxLength={32}
              disabled={disabled}
              className="w-full min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-caption font-medium text-text focus:border-accent-cyan disabled:opacity-50"
            />
            <span className="w-24 shrink-0"><DockSelect
              aria-label={axis.label}
              value={draft.ratings[axis.key] ?? ""}
              onChange={(event) => editRating(axis.key, event.target.value)}
              disabled={disabled}
              className="w-24 shrink-0 rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-caption text-text focus:border-accent-cyan disabled:opacity-50"
            >
              <option value="">Not set</option>
              {[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating}</option>)}
            </DockSelect></span>
          </div>
        ))}
      </div>
      <details className="rounded-md border border-border px-2.5 py-2 text-caption text-text-muted">
        <summary className="flex min-h-8 cursor-pointer items-center [@media(pointer:coarse)]:min-h-10 text-text">Rating guide</summary>
        <div className="mt-2 space-y-2">
          <p>Higher means more of that trait, including greater difficulty and micro demand. Rate each trait independently; a build can be aggressive and defensive.</p>
          {BUILD_PROFILE_AXES.map((axis) => <p key={axis.key}><span className="font-medium text-text">{axis.label}:</span> {axis.description}</p>)}
          <p>These are your assessments for this build, rather than automatic replay measurements or a measured ladder popularity rate.</p>
        </div>
      </details>
      <details className="min-w-0 rounded-md border border-border p-2 text-caption text-text-muted">
        <summary className="flex min-h-8 cursor-pointer items-center [@media(pointer:coarse)]:min-h-10 text-text">Preview graph</summary>
        <div className="mt-2">
          {draftComplete
            ? <BuildProfileChart profile={draft} preview />
            : <p className="py-2">Enter a build title and all five ratings to preview the graph.</p>}
        </div>
      </details>
      <div className="flex flex-wrap gap-2">
        <EditorButton disabled={disabled || !dirty || !canSave} onClick={() => void save()}>Save ratings</EditorButton>
        {dirty ? <EditorButton disabled={disabled} onClick={discard}>Discard edits</EditorButton> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <EditorButton disabled={disabled || profile.visible || !savedComplete || dirty} onClick={() => void setVisible(true)}>Show widget</EditorButton>
        <EditorButton disabled={disabled || !profile.visible} onClick={() => void setVisible(false)}>Hide widget</EditorButton>
      </div>
      <p className="text-micro text-text-dim">
        {dirty && !draftValid
          ? "Use labels of 1–32 characters and ratings of 1–5 or Not set."
          : dirty && !draftComplete && profile.visible
            ? "Hide the widget before saving an empty title or an unset rating."
          : dirty && !draftComplete
            ? "You can save partial or cleared ratings while hidden. Add a build title and all five ratings before showing the widget."
          : dirty
            ? "Save these edits before showing the widget. Saving updates a widget that is already shown."
            : "Show and hide use your saved ratings. The widget stays as you leave it until you change it here."}
      </p>
      <p className="text-micro text-text-dim">Enable Build profile in SC2Tools Settings → Overlay and add its Browser Source to OBS once. These controls then show or hide that source's graph.</p>
      {notice ? <p role="status" className="text-caption text-accent-cyan">{notice}</p> : null}
    </div>
  );
}

function EditorButton({ children, disabled, onClick }: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return <DockButton type="button" disabled={disabled} onClick={onClick} className="rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-caption font-medium text-text hover:border-accent-cyan/50 hover:text-accent-cyan disabled:cursor-not-allowed disabled:opacity-40">{children}</DockButton>;
}

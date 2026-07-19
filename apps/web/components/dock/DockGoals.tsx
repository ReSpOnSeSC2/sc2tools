"use client";

/**
 * DockGoals — stream-goal editor for the Stream Dock (up to 4 goals:
 * label, current, target). Edits are local until the single "Save
 * goals" POST replaces the studio's goal list wholesale; +1/−1 nudge
 * the current value locally so a "new follower" is two taps (nudge,
 * save) even in a 300px dock.
 *
 * Hydration follows the Settings-draft pattern: server state fills
 * the form until the first local edit, then local edits win until
 * saved (the parent hands back the server's sanitized state, which
 * re-hydrates on the next non-dirty render).
 */

import { useEffect, useState } from "react";
import type { StudioGoal } from "@/lib/multichat/useStudioState";
import { DockButton } from "./DockClient";

const GOALS_MAX = 4;

export function DockGoals({
  goals,
  busy,
  onPost,
}: {
  goals: ReadonlyArray<StudioGoal>;
  busy: boolean;
  onPost: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<StudioGoal[]>([...goals]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft([...goals]);
  }, [goals, dirty]);

  const edit = (i: number, patch: Partial<StudioGoal>) => {
    setDraft((prev) => prev.map((g, j) => (j === i ? { ...g, ...patch } : g)));
    setDirty(true);
  };

  const save = async () => {
    await onPost({
      goals: draft
        .filter((g) => g.label.trim())
        .map((g) => ({
          label: g.label.trim(),
          current: Math.max(0, Math.round(g.current) || 0),
          target: Math.max(1, Math.round(g.target) || 1),
        })),
    });
    setDirty(false);
  };

  return (
    <div className="space-y-2.5">
      {draft.length === 0 ? (
        <p className="text-caption text-text-dim">
          No goals yet — add one (e.g. "Followers 120 / 150").
        </p>
      ) : null}
      {draft.map((g, i) => (
        <div key={i} className="min-w-0 space-y-1.5 rounded-md border border-border p-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <input
              type="text"
              value={g.label}
              onChange={(e) => edit(i, { label: e.target.value })}
              placeholder="Goal label"
              maxLength={40}
              className="w-full min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              aria-label={`Remove goal ${i + 1}`}
              onClick={() => {
                setDraft((prev) => prev.filter((_, j) => j !== i));
                setDirty(true);
              }}
              className="rounded border border-border px-1.5 py-1 text-micro text-text-muted hover:border-danger hover:text-danger"
            >
              ✕
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-label={`Decrement ${g.label || `goal ${i + 1}`}`}
              onClick={() => edit(i, { current: Math.max(0, g.current - 1) })}
              className="rounded border border-border px-2 py-1 text-caption text-text hover:border-accent"
            >
              −1
            </button>
            <input
              type="number"
              min={0}
              value={g.current}
              onChange={(e) => edit(i, { current: Number(e.target.value) })}
              aria-label="Current value"
              className="w-16 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption tabular-nums text-text focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              aria-label={`Increment ${g.label || `goal ${i + 1}`}`}
              onClick={() => edit(i, { current: g.current + 1 })}
              className="rounded border border-border px-2 py-1 text-caption text-text hover:border-accent"
            >
              +1
            </button>
            <span className="text-caption text-text-dim">/</span>
            <input
              type="number"
              min={1}
              value={g.target}
              onChange={(e) => edit(i, { target: Number(e.target.value) })}
              aria-label="Target value"
              className="w-16 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption tabular-nums text-text focus:border-accent focus:outline-none"
            />
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {draft.length < GOALS_MAX ? (
          <DockButton
            onClick={() => {
              setDraft((prev) => [
                ...prev,
                { label: "", current: 0, target: 10 },
              ]);
              setDirty(true);
            }}
          >
            + Add goal
          </DockButton>
        ) : null}
        <DockButton disabled={busy || !dirty} onClick={() => void save()}>
          Save goals
        </DockButton>
      </div>
    </div>
  );
}

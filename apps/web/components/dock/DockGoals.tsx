"use client";

/**
 * DockGoals — stream-goal editor for the Stream Dock (up to 4 goals:
 * label, current, target). Value/label edits are local until the
 * single "Save goals" POST replaces the studio's goal list wholesale;
 * +1/−1 nudge the current value locally so a "new follower" is two
 * taps (nudge, save) even in a 300px dock.
 *
 * Deleting a row is the exception: ✕ POSTs the reduced list
 * IMMEDIATELY. The row disappearing from the dock must mean it's off
 * stream — a draft-only delete looks done while the overlay keeps
 * showing the goal until Save is also tapped. Because the POST ships
 * the current draft (minus the row), any pending edits on other rows
 * go live with it — what the dock shows is what the stream gets.
 *
 * Hydration follows the Settings-draft pattern: server state fills
 * the form until the first local edit, then local edits win until
 * saved (the parent hands back the server's sanitized state, which
 * re-hydrates on the next non-dirty render). The dirty flag is
 * mirrored into a ref that flips SYNCHRONOUSLY at the first edit:
 * the hydrate effect must never trust the state flag alone, because
 * a studio fetch resolving in the same beat as the user's first
 * click can commit a new ``goals`` identity while ``dirty`` is still
 * false — and silently wipe the edit (observed in stress runs).
 */

import { useEffect, useRef, useState } from "react";
import type { StudioGoal } from "@/lib/multichat/useStudioState";
import { DockButton } from "./DockClient";

const GOALS_MAX = 4;

/** Draft rows → the wire shape "Save goals" persists (labeled only). */
function toPostGoals(rows: ReadonlyArray<StudioGoal>): StudioGoal[] {
  return rows
    .filter((g) => g.label.trim())
    .map((g) => ({
      label: g.label.trim(),
      current: Math.max(0, Math.round(g.current) || 0),
      target: Math.max(1, Math.round(g.target) || 1),
    }));
}

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
  // Synchronous mirror of ``dirty`` — see the module comment.
  const dirtyRef = useRef(false);

  const markDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
  };
  const clearDirty = () => {
    dirtyRef.current = false;
    setDirty(false);
  };

  useEffect(() => {
    // ``dirty`` stays a dep so the true→false transition after a save
    // re-runs hydration; the ref is what's trusted, so an interleaved
    // commit carrying a stale false can't clobber a fresh edit.
    if (!dirtyRef.current) setDraft([...goals]);
  }, [goals, dirty]);

  const edit = (i: number, patch: Partial<StudioGoal>) => {
    setDraft((prev) => prev.map((g, j) => (j === i ? { ...g, ...patch } : g)));
    markDirty();
  };

  const save = async () => {
    await onPost({ goals: toPostGoals(draft) });
    clearDirty();
  };

  // ✕ — delete NOW, not on the next Save. Blank in-progress rows are
  // draft-only (never persisted), so removing one skips the POST; any
  // labeled row's removal must reach the stream immediately.
  const remove = async (i: number) => {
    const next = draft.filter((_, j) => j !== i);
    const payload = toPostGoals(next);
    setDraft(next);
    // Keep the draft protected from hydration while the POST is in
    // flight — a re-hydrate mid-flight would resurrect the row.
    markDirty();
    if (JSON.stringify(payload) !== JSON.stringify(toPostGoals([...goals]))) {
      await onPost({ goals: payload });
    }
    // Hand control back to server hydration unless blank in-progress
    // rows remain (sanitization drops them — hydrating would eat the
    // row being typed). On a failed POST the parent kept the old
    // state, so hydration restores the row next to the error banner —
    // the dock never silently disagrees with the stream.
    if (next.every((g) => g.label.trim())) clearDirty();
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
              disabled={busy}
              onClick={() => void remove(i)}
              className="rounded border border-border px-1.5 py-1 text-micro text-text-muted hover:border-danger hover:text-danger disabled:opacity-50"
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
              markDirty();
            }}
          >
            + Add goal
          </DockButton>
        ) : null}
        <DockButton disabled={busy || !dirty} onClick={() => void save()}>
          Save goals
        </DockButton>
        {dirty ? (
          <span className="self-center text-micro text-text-muted">
            Unsaved edits
          </span>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { apiCall, useApi } from "@/lib/clientApi";
import { armGhostTargetForMatchup, clearGhostTarget, MAX_GHOST_STEPS, readArmedGhostConfig, writeArmedGhostConfig, type GhostTarget } from "@/lib/ghostBuild";
import { GHOST_ARMED_EVENT } from "@/components/analyzer/game/useArmGhostTarget";

type GhostReferences = {
  v: 1;
  slots: Record<string, GhostTarget>;
  references: Record<string, { gameId: string; buildKey: string; side: string; matchup: string; target: GhostTarget; revision?: string }>;
  history?: Record<string, Array<{ revision: string }>>;
};

type UndoReference = { referenceKey: string; revision: string; expectedCurrentRevision: string | null };

export function StarGhostReplayButton({ gameId, buildKey, side = "you" }: {
  gameId: string;
  buildKey?: string;
  side?: "you" | "opponent";
}) {
  const { getToken, userId } = useAuth();
  const references = useApi<GhostReferences>("/v1/me/ghost-builds");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoReference | null>(null);
  const pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setMessage(null);
    setUndo(null);
    return () => request.current?.abort();
  }, [gameId, buildKey, side, userId]);
  const selected = Object.values(references.data?.references ?? {}).some((entry) =>
    entry.gameId === gameId && entry.side === side && (!buildKey || entry.buildKey === buildKey));

  async function choose() {
    if (pending.current) return;
    pending.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiCall<GhostReferences>(getToken, "/v1/me/ghost-builds/reference", {
        method: "PUT", body: JSON.stringify({ gameId, side, buildKey, clear: selected }), signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const changedKey = Object.entries(selected ? references.data?.references ?? {} : result.references)
        .find(([, row]) => row.gameId === gameId && row.side === side && (!buildKey || row.buildKey === buildKey))?.[0];
      const previous = changedKey ? result.history?.[changedKey]?.[0] : null;
      setUndo(changedKey && previous ? { referenceKey: changedKey, revision: previous.revision,
        expectedCurrentRevision: result.references[changedKey]?.revision ?? null } : null);
      await references.mutate(result, { revalidate: false });
      const entry = Object.values(result.references).find((row) => row.gameId === gameId && row.side === side && (!buildKey || row.buildKey === buildKey));
      if (!selected && entry) {
        armGhostTargetForMatchup(entry.matchup[0], entry.matchup[2], { ...entry.target, steps: entry.target.steps.slice(0, MAX_GHOST_STEPS) });
      }
      if (selected) {
        let config = readArmedGhostConfig();
        if (config) for (const [matchup, target] of Object.entries(config.slots)) {
          if (target?.sourceGameId === gameId && !result.slots[matchup]) {
            config = clearGhostTarget(config, matchup as keyof typeof config.slots);
            writeArmedGhostConfig(config);
          }
        }
      }
      window.dispatchEvent(new Event(GHOST_ARMED_EVENT));
      setMessage(selected ? "Reference removed. Other saved targets are unchanged." : "Reference saved for this build. Companion picks it up on refresh; Ghost remains under your control.");
    } catch {
      if (!controller.signal.aborted) setMessage("Could not save this reference. Refresh and try again; the replay needs a timed build order.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function restore() {
    if (!undo || pending.current) return;
    pending.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const result = await apiCall<GhostReferences>(getToken, "/v1/me/ghost-builds/reference/restore", {
        method: "PUT", body: JSON.stringify(undo), signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      await references.mutate(result, { revalidate: false });
      const entry = result.references[undo.referenceKey];
      if (entry) armGhostTargetForMatchup(entry.matchup[0], entry.matchup[2], { ...entry.target, steps: entry.target.steps.slice(0, MAX_GHOST_STEPS) });
      window.dispatchEvent(new Event(GHOST_ARMED_EVENT));
      setUndo(null);
      setMessage("Previous reference restored. Your newer changes in other builds are unchanged.");
    } catch {
      if (!controller.signal.aborted) setMessage("Could not restore this reference. It may have changed elsewhere; refresh before retrying.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <span className="inline-flex min-w-0 flex-col items-start gap-1" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
    <Button variant={selected ? "secondary" : "ghost"} size="sm" className="min-h-11" loading={busy}
      aria-pressed={selected} aria-label={selected ? "Remove Ghost reference" : "Use replay as Ghost reference"}
      iconLeft={<Star className="h-4 w-4" fill={selected ? "currentColor" : "none"} aria-hidden />}
      onClick={() => void choose()}>{selected ? "Ghost reference" : "Use as Ghost"}</Button>
    {message ? <span role="status" className="max-w-64 text-left text-micro text-text-muted">{message}</span> : null}
    {undo ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void restore()}>Undo reference change</Button> : null}
  </span>;
}

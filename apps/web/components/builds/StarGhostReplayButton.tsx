"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { apiCall, boundedApiRequest, useApi } from "@/lib/clientApi";
import { MAX_GHOST_STEPS, type GhostMatchupKey, type GhostTarget } from "@/lib/ghostBuild";
import { useGhostPractice } from "@/lib/useGhostPractice";

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
  const auth = useAuth();
  const owner = auth.isLoaded && auth.isSignedIn && auth.userId ? auth.userId : null;
  const scope = `${owner ?? ""}:${gameId}:${buildKey ?? ""}:${side}`;
  const current = useRef(scope); current.current = scope;
  const practice = useGhostPractice();
  const references = useApi<GhostReferences>("/v1/me/ghost-builds");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoReference | null>(null);
  const pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    current.current = scope; setMessage(null); setUndo(null); setBusy(false); pending.current = false;
    return () => { current.current = ""; const active = request.current; request.current = null; active?.abort(); };
  }, [scope]);
  const selected = !!owner && Object.values(references.data?.references ?? {}).some((entry) =>
    entry.gameId === gameId && entry.side === side && (!buildKey || entry.buildKey === buildKey));

  async function choose() {
    if (!owner || current.current !== scope || pending.current) return;
    pending.current = true;
    const controller = new AbortController();
    request.current = controller;
    const valid = () => current.current === scope && request.current === controller && !controller.signal.aborted;
    const getToken = async () => { const token = await auth.getToken(); if (!valid() || !token) throw new DOMException("Sign-in changed", "AbortError"); return token; };
    setBusy(true);
    setMessage(null);
    try {
      const result = await boundedApiRequest(signal => apiCall<GhostReferences>(getToken, "/v1/me/ghost-builds/reference", {
        method: "PUT", body: JSON.stringify({ gameId, side, buildKey, clear: selected }), signal,
      }), 20_000, controller.signal);
      if (!valid()) return;
      const changedKey = Object.entries(selected ? references.data?.references ?? {} : result.references)
        .find(([, row]) => row.gameId === gameId && row.side === side && (!buildKey || row.buildKey === buildKey))?.[0];
      const previous = changedKey ? result.history?.[changedKey]?.[0] : null;
      setUndo(changedKey && previous ? { referenceKey: changedKey, revision: previous.revision,
        expectedCurrentRevision: result.references[changedKey]?.revision ?? null } : null);
      await references.mutate(result, { revalidate: false });
      if (!valid()) return;
      const entry = Object.values(result.references).find((row) => row.gameId === gameId && row.side === side && (!buildKey || row.buildKey === buildKey));
      let assigned = true;
      if (!selected && entry) assigned = await practice.assign(entry.matchup as GhostMatchupKey, { ...entry.target, steps: entry.target.steps.slice(0, MAX_GHOST_STEPS) });
      if (selected && changedKey) {
        const previousEntry = references.data?.references[changedKey];
        const slot = previousEntry?.matchup as GhostMatchupKey | undefined;
        const currentTarget = slot ? practice.config.slots[slot] : null;
        if (slot && currentTarget?.sourceGameId === gameId && !result.slots[slot]) assigned = await practice.assign(slot, null, currentTarget);
      }
      if (!valid()) return;
      setMessage(!assigned ? "Reference saved, but the account practice assignment could not be confirmed. Use Practice to try again." : selected ? "Reference removed. Other saved targets are unchanged." : "Reference saved for this build. Account practice and your Ghost URL update automatically; the Companion panel remains under its own controls.");
    } catch {
      if (valid()) setMessage("Could not save this reference. Refresh and try again; the replay needs a timed build order.");
    } finally {
      if (request.current === controller) { request.current = null; pending.current = false; setBusy(false); }
    }
  }

  async function restore() {
    if (!owner || current.current !== scope || !undo || pending.current) return;
    pending.current = true;
    const controller = new AbortController();
    request.current = controller;
    const valid = () => current.current === scope && request.current === controller && !controller.signal.aborted;
    const getToken = async () => { const token = await auth.getToken(); if (!valid() || !token) throw new DOMException("Sign-in changed", "AbortError"); return token; };
    setBusy(true);
    try {
      const result = await boundedApiRequest(signal => apiCall<GhostReferences>(getToken, "/v1/me/ghost-builds/reference/restore", {
        method: "PUT", body: JSON.stringify(undo), signal,
      }), 20_000, controller.signal);
      if (!valid()) return;
      await references.mutate(result, { revalidate: false });
      if (!valid()) return;
      const entry = result.references[undo.referenceKey];
      const assigned = !entry || await practice.assign(entry.matchup as GhostMatchupKey, { ...entry.target, steps: entry.target.steps.slice(0, MAX_GHOST_STEPS) });
      if (!valid()) return;
      if (!assigned) { setMessage("Reference restored, but the account practice assignment could not be confirmed. Use Practice to try again."); return; }
      setUndo(null);
      setMessage("Previous reference restored. Your newer changes in other builds are unchanged.");
    } catch {
      if (valid()) setMessage("Could not restore this reference. It may have changed elsewhere; refresh before retrying.");
    } finally {
      if (request.current === controller) { request.current = null; pending.current = false; setBusy(false); }
    }
  }

  return <span className="inline-flex min-w-0 flex-col items-start gap-1" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
    <Button variant={selected ? "secondary" : "ghost"} size="sm" className="min-h-11" loading={busy} disabled={!owner || practice.saving}
      aria-pressed={selected} aria-label={selected ? "Remove Ghost reference" : "Use replay as Ghost reference"}
      iconLeft={<Star className="h-4 w-4" fill={selected ? "currentColor" : "none"} aria-hidden />}
      onClick={() => void choose()}>{selected ? "Ghost reference" : "Use as Ghost"}</Button>
    {message ? <span role="status" className="max-w-64 text-left text-micro text-text-muted">{message}</span> : null}
    {undo ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void restore()}>Undo reference change</Button> : null}
  </span>;
}

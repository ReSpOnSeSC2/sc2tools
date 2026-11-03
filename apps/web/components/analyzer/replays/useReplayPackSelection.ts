"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE, useOwnerRequestScope } from "@/lib/clientApi";
import { PACK_SELECTION_LIMIT, packSelectionRow, selectMatchingReplays, type PackSelectionRow } from "./replayPackSelection";

type Lifetime = { active: boolean; owner: string; query: string };
type Selection = { lifetime: Lifetime; revision: number; rows: ReadonlyMap<string, PackSelectionRow> };
type Matching = { lifetime: Lifetime; revision: number; controller: AbortController };
const empty: ReadonlyMap<string, PackSelectionRow> = new Map();

/** Pack100 is deliberately independent from ReplayLibrary's destructive page25 set. */
export function useReplayPackSelection(owner: string, query: string, blocked: boolean) {
  const auth = useAuth(), runOwned = useOwnerRequestScope(owner, auth.getToken);
  const lifetime = useMemo(() => ({ active: true, owner, query }), [owner, query]);
  const latest = useRef(lifetime); latest.current = lifetime;
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const revision = useRef(0), active = useRef<Matching | null>(null);
  const [selection, setSelection] = useState<Selection>({ lifetime, revision: 0, rows: empty });
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const [pending, setPending] = useState(false), [feedback, setFeedback] = useState<{ lifetime: Lifetime; message: string } | null>(null);
  const current = () => lifetime.active && latest.current === lifetime;
  useLayoutEffect(() => {
    lifetime.active = true;
    return () => { lifetime.active = false; if (active.current?.lifetime === lifetime) active.current.controller.abort(); };
  }, [lifetime]);
  useLayoutEffect(() => { if (blocked) active.current?.controller.abort(); }, [blocked]);
  const rows = selection.lifetime === lifetime ? selection.rows : empty;
  const edit = (next: ReadonlyMap<string, PackSelectionRow>) => {
    active.current?.controller.abort(); revision.current++;
    const nextSelection = { lifetime, revision: revision.current, rows: next }; selectionRef.current = nextSelection;
    setSelection(nextSelection); setFeedback(null);
  };
  const clear = () => { if (current()) edit(empty); };
  const toggle = (value: unknown) => {
    if (!current() || blockedRef.current || active.current) return;
    try {
      const row = packSelectionRow(value), next = new Map(selectionRef.current.lifetime === lifetime ? selectionRef.current.rows : empty);
      if (next.has(row.gameId)) next.delete(row.gameId);
      else { if (next.size >= PACK_SELECTION_LIMIT) return; next.set(row.gameId, row); }
      edit(next);
    } catch { setFeedback({ lifetime, message: "Couldn't select that replay. Refresh the list and try again." }); }
  };
  async function matching(): Promise<boolean> {
    if (!current() || blockedRef.current || active.current) return false;
    const operation: Matching = { lifetime, revision: revision.current, controller: new AbortController() }; active.current = operation;
    setPending(true); setFeedback(null);
    let actual: Promise<readonly PackSelectionRow[]> | undefined;
    try {
      const result = await runOwned(owner, (token, signal, assertOwner) => {
        const assertCurrent = () => { assertOwner(); if (!current() || blockedRef.current || revision.current !== operation.revision || active.current !== operation) throw new DOMException("Retired selection", "AbortError"); };
        actual = selectMatchingReplays(API_BASE, query, { token, signal, assertCurrent }); return actual;
      }, undefined, operation.controller.signal);
      if (!current() || blockedRef.current || revision.current !== operation.revision || active.current !== operation) return false;
      revision.current++; const nextSelection = { lifetime, revision: revision.current, rows: new Map(result.map(row => [row.gameId, row])) };
      selectionRef.current = nextSelection; setSelection(nextSelection);
      setFeedback({ lifetime, message: `${result.length} selected from the first 100 matching games in this sort.` }); return true;
    } catch {
      if (current()) setFeedback({ lifetime, message: operation.controller.signal.aborted ? "Selection cancelled. Your selection is unchanged." : "Couldn't select matching replays. Your selection is unchanged. Try again." });
      return false;
    } finally {
      if (actual) await Promise.allSettled([actual]);
      if (active.current === operation) { active.current = null; setPending(false); }
    }
  }
  return { rows, selectedIds: new Set(rows.keys()), revision: selection.lifetime === lifetime ? selection.revision : revision.current,
    scope: JSON.stringify([owner, query, selection.lifetime === lifetime ? selection.revision : revision.current]),
    pending, message: feedback?.lifetime === lifetime ? feedback.message : null, toggle, clear, matching,
    cancelMatching: () => { if (active.current?.lifetime === lifetime) active.current.controller.abort(); } };
}

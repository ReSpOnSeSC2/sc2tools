"use client";
import { useLayoutEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUrlState } from "@/lib/useUrlState";
import { parseStrategyDrill, serializeStrategyDrill } from "@/lib/strategyDrillUrl";
import type { StrategyDrillFilter } from "@/lib/strategyDrill";
import { StrategiesTab, type StratView } from "./StrategiesTab";
const viewOptions = { defaultValue: "bvs" as StratView, storageKey: "analyzer.strategies.view", parse: (raw: string | null): StratView => raw === "opp" ? "opp" : "bvs", serialize: (value: StratView) => value };
const drillOptions = { defaultValue: null, parse: parseStrategyDrill, serialize: serializeStrategyDrill, mode: "push" as const };
const ENTRY = "sc2toolsStrategyDrill";
const OWNED = "analyzer.strategy-drill-entries";
function rememberEntry(entry: { id: string; raw: string }) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(OWNED) || "[]");
    const recent = Array.isArray(saved) ? saved.filter(row => row && typeof row.id === "string" && typeof row.raw === "string" && row.id !== entry.id).slice(-15) : [];
    sessionStorage.setItem(OWNED, JSON.stringify([...recent, { id: entry.id, raw: entry.raw, path: window.location.pathname }]));
  } catch { /* Current mounted ownership is still available without storage. */ }
}
export function StrategiesUrlView() {
  const router = useRouter(), view = useUrlState("view", viewOptions), drill = useUrlState<StrategyDrillFilter | null>("drill", drillOptions);
  const opening = useRef<{ id: string; raw: string; from: string; marked: boolean } | null>(null), sequence = useRef(0), closing = useRef(false);
  const currentRaw = serializeStrategyDrill(drill.committedValue);
  useLayoutEffect(() => {
    closing.current = false;
    const entry = opening.current;
    if (!entry || entry.marked || entry.raw !== currentRaw || window.history.state?.[ENTRY] !== entry.id) return;
    // Only the shared writer restores markers after an exact browser/ack match.
    entry.marked = true;
    rememberEntry(entry);
  }, [currentRaw]);
  const setDrill = (next: StrategyDrillFilter | null) => {
    if (closing.current) return;
    const raw = serializeStrategyDrill(next);
    if (raw === currentRaw) return;
    if (raw) {
      const pending = opening.current && !opening.current.marked;
      opening.current = { id: pending ? opening.current!.id : `${Date.now()}-${++sequence.current}`, raw, from: `${window.location.pathname}${window.location.search}`, marked: false };
      rememberEntry(opening.current);
      drill.setValue(next, { mode: currentRaw || pending ? "replace" : "push", historyState: { [ENTRY]: opening.current.id } });
    } else {
      closing.current = true;
      const owned = opening.current;
      let sessionOwned = false;
      try {
        const saved = JSON.parse(sessionStorage.getItem(OWNED) || "[]");
        sessionOwned = Array.isArray(saved) && saved.length <= 16 && saved.some(row => row?.id === window.history.state?.[ENTRY] && row?.raw === currentRaw && row?.path === window.location.pathname);
      } catch { /* Direct links use replacement. */ }
      if (sessionOwned || owned?.marked && owned.raw === currentRaw && window.history.state?.[ENTRY] === owned.id) router.back();
      else drill.setValue(null, { mode: "replace" });
    }
  };
  return <StrategiesTab view={view.value} onViewChange={view.setValue} drill={drill.committedValue} onDrillChange={setDrill} />;
}

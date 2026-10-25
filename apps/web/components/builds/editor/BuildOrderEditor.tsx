"use client";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, boundedApiRequest } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { BuildOrderEvent } from "@/lib/build-events";
import { REFERENCE_ORDER_LIMITS, readReferenceBuildOrder, type ReferenceBuildOrder, type ReferenceBuildStep } from "@/lib/buildOrderReference";
import { collapseReferenceArmy, parseReferenceClock, referenceClock, referenceFromGame } from "@/lib/buildOrderReferenceEditing";
import { BuildOrderPaste } from "./BuildOrderPaste";
import { TokenPicker } from "./TokenPicker";

function TimeInput({ value, onChange, disabled, label, caption = "Time" }: { value: number | null; onChange: (t: number | null) => void; disabled: boolean; label: string; caption?: string }) {
  const [text, setText] = useState(value !== null && value < 0 ? "" : referenceClock(value));
  useEffect(() => { if (value === null || value >= 0) setText(referenceClock(value)); }, [value]);
  return <label className="block space-y-1 text-caption">{caption}<Input aria-label={label} disabled={disabled} value={text} placeholder="m:ss" onChange={event => { setText(event.target.value); onChange(parseReferenceClock(event.target.value)); }} aria-invalid={value !== null && value < 0} />{value !== null && value < 0 ? <span className="block text-danger">Use m:ss, or leave blank for unknown.</span> : null}</label>;
}

export function BuildOrderEditor({ value, onChange, race, sourceEvents, sourceGameId, perspective = "you", disabled: blocked = false, error }: {
  value?: ReferenceBuildOrder; onChange: (value: ReferenceBuildOrder) => void; race?: string; sourceEvents: readonly BuildOrderEvent[]; sourceGameId?: string; perspective?: "you" | "opponent"; disabled?: boolean; error?: string;
}) {
  const { userId, isLoaded, isSignedIn, getToken } = useAuth();
  const [filling, setFilling] = useState(false);
  const source = `${userId ?? ""}:${isLoaded}:${isSignedIn}:${sourceGameId ?? ""}:${perspective}:${blocked}`;
  const epoch = useRef({ source, identity: {} });
  if (epoch.current.source !== source) epoch.current = { source, identity: {} };
  const request = useRef<AbortController | null>(null);
  useEffect(() => { const active = epoch.current; setFilling(false); return () => { if (epoch.current === active) epoch.current = { source, identity: {} }; request.current?.abort(); }; }, [source]);
  const disabled = blocked || filling;
  const [paste, setPaste] = useState(false), [notice, setNotice] = useState("");
  const drag = useRef<number | null>(null), steps = value?.steps ?? [];
  const write = (next: ReferenceBuildStep[]) => onChange({ ...(value ?? { v: 1, source: "manual" }), steps: next });
  const patch = (index: number, change: Partial<ReferenceBuildStep>) => write(steps.map((step, row) => row === index ? { ...step, ...change } : step));
  const insert = (index: number) => { if (steps.length < REFERENCE_ORDER_LIMITS.steps) write([...steps.slice(0, index), { t: null, supply: null, action: "" }, ...steps.slice(index)]); };
  const move = (from: number, to: number) => { if (from === to || to < 0 || to >= steps.length) return; const rows = [...steps]; rows.splice(to, 0, rows.splice(from, 1)[0]); write(rows); setNotice(`Step ${from + 1} moved to ${to + 1}.`); };
  async function fill() {
    if (disabled) return;
    if (sourceEvents.length) { onChange(referenceFromGame(sourceEvents, sourceGameId)); setNotice("Filled from the loaded source game; workers are folded into supply."); return; }
    if (!sourceGameId || !isLoaded || !isSignedIn || !userId) return;
    const active = epoch.current.identity, controller = new AbortController(); request.current?.abort(); request.current = controller;
    setFilling(true); setNotice("Loading the source game…");
    try {
      const data = await boundedApiRequest(signal => apiCall<{ events?: BuildOrderEvent[]; opp_events?: BuildOrderEvent[] }>(getToken, `/v1/games/${encodeURIComponent(sourceGameId)}/build-order`, { signal }), 8000, controller.signal);
      if (controller.signal.aborted || epoch.current.identity !== active) return;
      const events = perspective === "opponent" ? data.opp_events : data.events;
      if (!Array.isArray(events)) throw new Error("The source game has no build order for this side.");
      onChange(referenceFromGame(events, sourceGameId)); setNotice("Filled from the source game; workers are folded into supply.");
    } catch (failure) { if (!controller.signal.aborted && epoch.current.identity === active) setNotice(failure instanceof Error ? failure.message : "The source game could not be loaded. Try again."); }
    finally { if (epoch.current.identity === active) setFilling(false); }
  }
  return <section aria-label="Edit reference build order" className="min-w-0 space-y-4">
    <p className="text-caption text-text-muted">A practice plan, separate from match rules. Blank times stay unknown. Practice treats upgrade clocks as completion times. Source fill keeps recorded completion when available and folds workers into supply. Step notes are shared if you publish; personal notes stay private.</p>
    {error || value && !readReferenceBuildOrder(value) ? <p role="alert" className="text-caption text-danger">{error || "Check every step: use valid m:ss times, supply 0–1,000, nonempty actions (80 characters) and notes (140 characters)."}</p> : null}
    <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={disabled} onClick={() => setPaste(open => !open)} aria-expanded={paste}>Paste order</Button><Button variant="secondary" disabled={disabled || !sourceEvents.length && (!sourceGameId || !isLoaded || !isSignedIn)} title={!sourceEvents.length && !sourceGameId ? "This build has no source replay." : undefined} onClick={() => void fill()}>Fill from source game</Button><Button variant="secondary" disabled={disabled || !steps.length} onClick={() => { write(steps.filter(step => step.t === null || step.t <= 300)); setNotice("Removed steps after 5:00; untimed steps were kept."); }}>Trim to first 5:00</Button><Button variant="secondary" disabled={disabled || !steps.length} onClick={() => { write(collapseReferenceArmy(steps)); setNotice("Collapsed adjacent repeated army actions; notes keep the count and last time."); }}>Collapse repeated army units</Button></div>
    {paste ? <BuildOrderPaste disabled={disabled} race={race} onImport={order => { onChange(order); setPaste(false); setNotice("Imported reference steps. Match rules are unchanged."); }} /> : null}
    <p role="status" className="text-caption text-text-muted">{notice || `${steps.length} / 120 reference steps`}</p>
    <ol className="space-y-3">{steps.map((step, index) => <li key={index} draggable={!disabled} onDragStart={() => { drag.current = index; }} onDragEnd={() => { drag.current = null; }} onDragOver={event => { if (!disabled) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!disabled && drag.current !== null) move(drag.current, index); drag.current = null; }} className="min-w-0 space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-caption font-semibold">Step {index + 1}</span><div className="flex flex-wrap gap-1"><Button variant="ghost" disabled={disabled || index === 0} onClick={() => move(index, index - 1)} aria-label={`Move step ${index + 1} up`}>↑</Button><Button variant="ghost" disabled={disabled || index === steps.length - 1} onClick={() => move(index, index + 1)} aria-label={`Move step ${index + 1} down`}>↓</Button><Button variant="ghost" disabled={disabled || steps.length >= 120} onClick={() => insert(index + 1)}>Insert after {index + 1}</Button><Button variant="ghost" disabled={disabled} onClick={() => write(steps.filter((_row, row) => row !== index))} aria-label={`Delete step ${index + 1}`}>Delete</Button></div></div>
      <div className="grid min-w-0 grid-cols-2 gap-3"><TimeInput value={step.t} onChange={t => patch(index, { t })} label={`Step ${index + 1} time`} caption={/^Research[A-Z]/.test(step.action) ? "Completion time" : "Time"} disabled={disabled} /><label className="space-y-1 text-caption">Supply<Input type="number" aria-label={`Step ${index + 1} supply`} min={0} max={1000} disabled={disabled} value={step.supply ?? ""} onChange={event => patch(index, { supply: event.target.value === "" ? null : Number(event.target.value), supplyApprox: false })} /></label></div>
      {step.supplyApprox ? <p className="text-caption text-text-muted">≈ Supply is approximate, taken from a prior recorded sample.</p> : null}
      <TokenPicker allowUnknown disabled={disabled} value={step.action} race={race} label={`Step ${index + 1} action`} onChange={action => patch(index, { action })} />
      <label className="block space-y-1 text-caption">Shareable step note<Input aria-label={`Step ${index + 1} note`} maxLength={140} disabled={disabled} value={step.note ?? ""} onChange={event => patch(index, { note: event.target.value })} /></label>
    </li>)}</ol>
    <Button variant="secondary" disabled={disabled || steps.length >= 120} onClick={() => insert(steps.length)}>Add reference step</Button>
  </section>;
}

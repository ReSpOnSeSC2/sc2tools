"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { DockButton, DockInput } from "./DockControls";

async function copyText(value: string, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    signal.throwIfAborted();
    await Promise.race([navigator.clipboard.writeText(value), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Clipboard timed out")), 3000);
      abort = () => reject(new DOMException("Copy cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

/** Clipboard failure must leave a usable, selected manual-copy field. */
export function DockCopyText({ value, label, disabled = false }: { value: string; label: string; disabled?: boolean }) {
  const identity = useRef({ value });
  if (identity.current.value !== value) identity.current = { value };
  const scope = identity.current, mounted = useRef(true), trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null), area = useRef<HTMLTextAreaElement>(null), instructions = useId();
  const pending = useRef<{ scope: typeof scope; controller: AbortController } | null>(null);
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; mode: "copying" | "copied" | "manual" } | null>(null);
  const mode = snapshot?.scope === scope ? snapshot.mode : "idle";
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (pending.current?.scope === scope) pending.current.controller.abort(); };
  }, [scope]);
  useLayoutEffect(() => {
    if (mode !== "manual") return;
    const field = value.includes("\n") ? area.current : input.current;
    field?.focus(); field?.select();
  }, [mode, value]);
  useEffect(() => {
    if (mode !== "copied") return;
    const timer = setTimeout(() => setSnapshot(previous => previous?.scope === scope ? null : previous), 1500);
    return () => clearTimeout(timer);
  }, [mode, scope]);
  const copy = async () => {
    if (pending.current?.scope === scope || disabled || !value) return;
    const request = { scope, controller: new AbortController() }; pending.current = request; setSnapshot({ scope, mode: "copying" });
    try {
      await copyText(value, request.controller.signal);
      if (mounted.current && identity.current === scope && !request.controller.signal.aborted) setSnapshot({ scope, mode: "copied" });
    } catch {
      if (mounted.current && identity.current === scope && !request.controller.signal.aborted) setSnapshot({ scope, mode: "manual" });
    } finally { if (pending.current === request) pending.current = null; }
  };
  return <div className="min-w-0 max-w-full space-y-2">
    <DockButton ref={trigger} disabled={disabled || !value} loading={mode === "copying"} onClick={() => void copy()} iconLeft={mode === "copied" ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}>{mode === "copied" ? "Copied" : label}</DockButton>
    {mode === "manual" ? <div className="min-w-0 space-y-2">
      <p id={instructions} role="status" className="text-caption text-text-muted">Press Ctrl+C (or Cmd+C) to copy the selected text.</p>
      {value.includes("\n") ? <textarea ref={area} readOnly value={value} rows={4} aria-label={`${label} manually`} aria-describedby={instructions} onFocus={event => event.currentTarget.select()} className="block min-h-24 w-full resize-y rounded-md border-2 border-line bg-bg-surface px-2 py-2 font-mono text-caption text-text focus-visible:ring-2 focus-visible:ring-accent" />
        : <DockInput ref={input} readOnly value={value} aria-label={`${label} manually`} aria-describedby={instructions} onFocus={event => event.currentTarget.select()} className="font-mono" />}
      <DockButton onClick={() => { setSnapshot(null); trigger.current?.focus(); }}>Hide copy field</DockButton>
    </div> : null}
  </div>;
}

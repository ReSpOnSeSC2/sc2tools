"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import type { BuildExportMeta, ExportStep } from "@/lib/gameExport";
import type { BuildRule } from "@/lib/build-rules";
import type { ReferenceBuildOrder } from "@/lib/buildOrderReference";
import { useToastOptional } from "@/components/ui/Toast";

/** Native disclosure keeps Tab order and source focus; formatters load on demand. */
export function BuildExportMenu({ steps, meta, rules = [], extraActions, reference }: {
  steps: readonly ExportStep[]; meta: BuildExportMeta; rules?: readonly BuildRule[]; extraActions?: ReactNode; reference?: ReferenceBuildOrder;
}) {
  const root = useRef<HTMLDetailsElement>(null), trigger = useRef<HTMLElement>(null), fallbackInput = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const [fallback, setFallback] = useState("");
  const [message, setMessage] = useState("");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [printText, setPrintText] = useState("");
  const operation = useRef(0);
  const cancelOperation = useCallback(() => { operation.current++; }, []);
  const clearFeedback = useCallback(() => { cancelOperation(); setFallback(""); setMessage(""); setSkipped([]); setPrintText(""); }, [cancelOperation]);
  const dismiss = useCallback(() => { clearFeedback(); if (root.current) root.current.open = false; }, [clearFeedback]);
  const toast = useToastOptional();
  const absoluteMeta = () => ({ ...meta, sourceUrl: new URL(meta.sourceUrl, window.location.origin).href });
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (root.current && !root.current.parentElement?.contains(event.target as Node)) dismiss(); };
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("pointerdown", outside); cancelOperation(); };
  }, [dismiss, cancelOperation]);
  useEffect(() => { if (fallback) { fallbackInput.current?.focus(); fallbackInput.current?.select(); } }, [fallback]);
  useEffect(() => {
    if (!printText) return;
    const frame = requestAnimationFrame(() => { try { window.print(); } finally { setPrintText(""); } });
    return () => cancelAnimationFrame(frame);
  }, [printText]);
  const copy = async (kind: "text" | "supply" | "markdown" | "salt" | "print" | "download") => {
    const ticket = ++operation.current, current = () => ticket === operation.current;
    setMessage(""); setFallback(""); setSkipped([]);
    try {
      const format = await import("@/lib/gameExport"); if (!current()) return; const metadata = absoluteMeta();
      let text: string;
      if (reference) text = kind === "markdown" ? format.referenceBuildToMarkdown(reference.steps, metadata) : format.referenceBuildToText(kind === "print" ? reference.steps.slice(0, 60) : reference.steps, metadata);
      else if (kind === "salt") { const result = format.buildToSalt(steps, metadata); text = result.salt; setSkipped(result.skipped); }
      else if (kind === "markdown") text = format.buildToMarkdownTable(steps, metadata, rules);
      else text = format.buildToText(kind === "print" ? steps.slice().sort((a, b) => a.time - b.time).slice(0, 60) : steps, metadata, kind === "supply" ? "supply-clock" : "clock", rules);
      if (kind === "print") { const total = reference ? reference.steps.length : steps.length; setPrintText(text + (total > 60 ? `\n\nFirst 60 of ${total} steps. Copy build order includes every step.` : "")); return; }
      if (kind === "download") { const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `${format.gameExportFilename(null, meta.matchup, meta.title)}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage("Text file prepared"); return; }
      try { await navigator.clipboard.writeText(text); if (current()) { setMessage("Copied"); toast?.toast.success("Build order copied"); } }
      catch { if (current()) setFallback(text); }
    } catch { if (current()) setMessage("Couldn't prepare this export. Please try again."); }
  };
  const buttonClass = "block min-h-11 w-full rounded px-3 py-2 text-left text-caption text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";
  return <div className="relative flex-none" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); dismiss(); trigger.current?.focus(); }
  }}>
    <details ref={root} className="relative">
      <summary ref={trigger} onClick={clearFeedback} aria-label={`Build actions for ${meta.title}`} className="inline-flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-lg border border-border bg-bg-surface px-2 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden"><MoreHorizontal className="h-4 w-4" aria-hidden /></summary>
      <div role="group" aria-label={`Export ${meta.title}`} className="absolute right-0 z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-bg-surface p-1 shadow-lg" onClickCapture={event => {
        if ((event.target as Element).closest("button")) { if (root.current) root.current.open = false; trigger.current?.focus(); }
      }}>
        <button type="button" className={buttonClass} onClick={() => void copy("text")}>Copy build order</button>
        {!reference ? <button type="button" className={buttonClass} disabled={!steps.length} onClick={() => void copy("supply")}>Copy as supply build</button> : null}
        <button type="button" className={buttonClass} onClick={() => void copy("markdown")}>Copy Markdown</button>
        {!reference ? <button type="button" className={buttonClass} disabled={!steps.length} title={!steps.length ? "Rules describe conditions; SALT needs timed build steps." : undefined} onClick={() => void copy("salt")}>Copy SALT</button> : null}
        <button type="button" className={buttonClass} onClick={() => void copy("download")}>Download .txt</button>
        <button type="button" className={buttonClass} onClick={() => void copy("print")}>Print cheat sheet</button>
        {extraActions ? <div className="border-t border-border pt-1">{extraActions}</div> : null}
      </div>
    </details>
    {message || skipped.length || fallback ? <div className="absolute right-0 top-full z-40 mt-1 max-h-72 w-64 max-w-[calc(100vw-3rem)] space-y-2 overflow-auto rounded-lg border border-border bg-bg-surface p-3 shadow-lg [overflow-wrap:anywhere]">
      {message ? <p role="status" className="text-caption text-text-muted">{message}</p> : null}
      {skipped.length ? <div role="status" className="text-caption text-text-muted"><p>SALT skipped {skipped.length} {skipped.length === 1 ? "step" : "steps"}:</p><ul className="list-inside list-disc">{skipped.map((name, index) => <li key={`${name}:${index}`}>{name}</li>)}</ul></div> : null}
      {fallback ? <div><label htmlFor={id} className="text-caption">Copy this build order</label><textarea ref={fallbackInput} id={id} readOnly value={fallback} rows={5} className="block w-full min-w-0 rounded border border-border bg-bg-surface p-2 font-mono text-micro text-text" onFocus={event => event.currentTarget.select()} /></div> : null}
      <button type="button" className="min-h-11 rounded px-2 text-caption text-accent underline focus-visible:ring-2 focus-visible:ring-accent" onClick={() => { dismiss(); trigger.current?.focus(); }}>Done</button>
    </div> : null}
    {printText && typeof document !== "undefined" ? createPortal(<section data-build-print-sheet className="hidden"><h1>{meta.title}</h1><p>{meta.matchup || "Any matchup"} · by {meta.author || "Anonymous"}</p><pre>{printText.split("\n").slice(2).join("\n")}</pre></section>, document.body) : null}
  </div>;
}

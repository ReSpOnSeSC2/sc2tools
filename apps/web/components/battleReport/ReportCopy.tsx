"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { reportText, type BattleReport } from "@/lib/battleReport/plan";

export function ReportCopy({ report, pending = false }: { report: BattleReport; pending?: boolean }) {
  const [copied, setCopied] = useState("");
  const [fallback, setFallback] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (fallback) { field.current?.focus(); field.current?.select(); } }, [fallback]);
  const copy = async (markdown: boolean) => {
    const value = reportText(report, markdown); setCopied("");
    try { await navigator.clipboard.writeText(value); setFallback(""); setCopied(markdown ? "Markdown copied." : "Report text copied."); }
    catch { setFallback(value); }
  };
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><Button disabled={pending} variant="secondary" size="sm" onClick={() => { void copy(false); }}>Copy text</Button><Button disabled={pending} variant="ghost" size="sm" onClick={() => { void copy(true); }}>Copy Markdown</Button>{copied ? <span role="status" className="text-micro text-success">{copied}</span> : null}</div>
    {fallback ? <label className="block text-caption text-text-muted">Copy this battle report<textarea ref={field} readOnly value={fallback} onFocus={(event) => event.currentTarget.select()} className="mt-2 min-h-40 w-full rounded-lg border border-border bg-bg-surface p-3 font-mono text-caption text-text" /></label> : null}
  </div>;
}

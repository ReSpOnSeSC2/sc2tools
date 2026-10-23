"use client";

import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";
import { collectReportContext, summariseReportContext, webBuildSha } from "@/lib/feedback/reportContext";
import type { SetupMe } from "./setupHealth";

/** Allowlisted fields reuse the report context's browser/URL sanitization. */
export function setupDiagnostics(me: SetupMe | undefined, warningIds: string[] | undefined, environment: { userAgent: string; width: number; height: number; now: number }) {
  const context = collectReportContext({ pathname: "/settings", userAgent: environment.userAgent,
    viewport: { width: environment.width, height: environment.height }, failedRequests: [],
    me, build: webBuildSha(), now: environment.now });
  return [`User ID: ${me?.userId || "Not loaded"}`, summariseReportContext(context),
    `Games: ${me?.games?.total ?? "Not loaded"}`, `Doctor warnings: ${warningIds ? warningIds.join(", ") || "none reported" : "Not loaded"}`,
    `Checked: ${new Date(environment.now).toISOString()}`].join("\n");
}

export function CopySetupDiagnostics({ me, warnings }: { me?: SetupMe; warnings?: string[] }) {
  const [fallback, setFallback] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const toast = useToastOptional()?.toast;
  useEffect(() => { if (fallback) { field.current?.focus(); field.current?.select(); } }, [fallback]);
  async function copy() {
    const text = setupDiagnostics(me, warnings, { userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, now: Date.now() });
    try { await navigator.clipboard.writeText(text); setFallback(""); toast?.success("Diagnostics copied"); }
    catch { setFallback(text); toast?.info("Select and copy the diagnostics below"); }
  }
  return <div className="space-y-2"><Button variant="secondary" size="sm" disabled={!me} onClick={() => { void copy(); }} iconLeft={<Copy className="h-4 w-4" aria-hidden />}>Copy diagnostics</Button>{fallback ? <textarea ref={field} readOnly aria-label="Diagnostics to copy" value={fallback} rows={6} className="w-full rounded border border-border bg-bg-elevated p-2 font-mono text-caption" /> : null}</div>;
}

export function CopyUserId({ value }: { value: string }) {
  const text = useRef<HTMLSpanElement>(null);
  const [fallback, setFallback] = useState(false);
  const toast = useToastOptional()?.toast;
  async function copy() {
    try { await navigator.clipboard.writeText(value); setFallback(false); toast?.success("User ID copied"); }
    catch {
      const selection = window.getSelection(); const range = document.createRange();
      if (text.current) { range.selectNodeContents(text.current); selection?.removeAllRanges(); selection?.addRange(range); }
      setFallback(true);
    }
  }
  return <div className="min-w-0"><div className="flex items-start gap-1"><span ref={text} className="min-w-0 break-all font-mono text-caption">{value}</span><Button variant="ghost" size="sm" aria-label="Copy user ID" onClick={() => { void copy(); }} iconLeft={<Copy className="h-4 w-4" aria-hidden />} /></div>{fallback ? <p className="text-micro text-text-muted">Selected. Copy with your keyboard or selection menu.</p> : null}</div>;
}

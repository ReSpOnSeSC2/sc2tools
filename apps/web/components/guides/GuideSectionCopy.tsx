"use client";
import { useEffect, useRef, useState } from "react";
import { Link2 } from "lucide-react";
import { useToastOptional } from "@/components/ui/Toast";

export function GuideSectionCopy({ id, label }: { id: string; label: string }) {
  const toast = useToastOptional();
  const [fallback, setFallback] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (fallback) { input.current?.focus(); input.current?.select(); } }, [fallback]);
  async function copy() {
    const link = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(id)}`;
    try { await navigator.clipboard.writeText(link); setCopied(true); toast?.toast.success("Link copied"); }
    catch { setFallback(link); }
  }
  return <div className="flex items-center gap-2 print:hidden"><button type="button" onClick={() => void copy()} aria-label={`Copy link to ${label}`} className="grid h-11 w-11 place-items-center rounded-md text-accent opacity-0 group-hover/guide:opacity-100 group-focus-within/guide:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [@media(pointer:coarse)]:opacity-100"><Link2 className="h-4 w-4" aria-hidden /></button>{copied ? <span role="status" className="sr-only">Link copied</span> : null}{fallback ? <input ref={input} readOnly value={fallback} aria-label="Copy this section link" className="max-w-40 rounded border border-border bg-bg text-caption text-text" /> : null}</div>;
}

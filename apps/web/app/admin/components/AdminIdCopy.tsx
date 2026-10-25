"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";

export function AdminIdCopy({ label, value }: { label: string; value: string }) {
  const toast = useToastOptional(), input = useRef<HTMLInputElement>(null), attempt = useRef({ version: 0 });
  const [fallback, setFallback] = useState(false), [copied, setCopied] = useState(false);
  useLayoutEffect(() => { const guard = attempt.current; guard.version++; setFallback(false); setCopied(false); return () => { guard.version++; }; }, [value]);
  useLayoutEffect(() => { if (fallback) { input.current?.focus(); input.current?.select(); } }, [fallback]);
  const copy = async () => {
    const id = ++attempt.current.version;
    try {
      await navigator.clipboard.writeText(value);
      if (id !== attempt.current.version) return;
      setCopied(true); setFallback(false); toast?.toast.success("Copied");
    } catch {
      if (id !== attempt.current.version) return;
      setFallback(true); setCopied(false);
    }
  };
  return <div className="min-w-0 space-y-1"><div className="flex flex-wrap items-center gap-2"><span className="text-caption text-text-muted">{label}</span><code className="break-all text-caption">{value}</code><Button size="sm" variant="ghost" aria-label={`Copy ${label}`} onClick={() => void copy()}>Copy</Button>{copied ? <span role="status" className="text-caption text-success">Copied</span> : null}</div>{fallback ? <label className="block text-caption text-text-muted">Select and copy {label}<input ref={input} aria-label={`${label} to copy`} readOnly value={value} onFocus={event => event.currentTarget.select()} className="mt-1 w-full rounded border border-border bg-bg-elevated p-2 font-mono text-text" /></label> : null}</div>;
}

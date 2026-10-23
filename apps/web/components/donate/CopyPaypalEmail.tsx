"use client";
import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { useToastOptional } from "@/components/ui/Toast";

export function CopyPaypalEmail({ email }: { email: string }) {
  const code = useRef<HTMLElement>(null);
  const [status, setStatus] = useState("");
  const notifications = useToastOptional();
  useEffect(() => { if (!status) return; const timer = setTimeout(() => setStatus(""), 4000); return () => clearTimeout(timer); }, [status]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(email);
      if (notifications) notifications.toast.success("Email copied"); else setStatus("Email copied");
    } catch {
      if (code.current) {
        const range = document.createRange(); range.selectNodeContents(code.current);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      }
      setStatus("Copy unavailable — email selected. Use your keyboard to copy it.");
    }
  }
  return <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
    <code ref={code} className="break-all rounded bg-bg-elevated px-1.5 py-0.5 font-mono text-caption">{email}</code>
    <button type="button" onClick={() => void copy()} aria-label="Copy PayPal email" className="inline-flex h-9 min-w-9 items-center justify-center rounded border border-border text-text-muted hover:text-text"><Copy className="h-4 w-4" aria-hidden /></button>
    {status ? <span role="status" className="fixed bottom-above-chrome right-3 z-toast max-w-[calc(100vw-1.5rem)] rounded-md border border-border bg-bg-surface p-3 text-caption text-text shadow-hard">{status}</span> : null}
  </span>;
}

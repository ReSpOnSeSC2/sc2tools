"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";
import { formatGameClock } from "@/lib/macro";

export function GameClockLink({ time, getHref }: { time: number; getHref: () => string }) {
  const toast = useToastOptional();
  const [fallback, setFallback] = useState("");
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null); const id = useId();
  useEffect(() => { if (fallback) { input.current?.focus(); input.current?.select(); } }, [fallback]);
  return <span className="inline-flex max-w-full flex-wrap items-center gap-2">
    <Button size="sm" variant="ghost" iconLeft={<Link2 className="h-4 w-4" aria-hidden />} onClick={async () => {
      const href = getHref(); setCopied(false);
      try { await navigator.clipboard.writeText(href); setFallback(""); setCopied(true); toast?.toast.success(`Link copied at ${formatGameClock(time)}`); }
      catch { setFallback(href); }
    }}>Copy link at {formatGameClock(time)}</Button>
    {copied ? <span role="status" className="sr-only">Link copied</span> : null}
    {fallback ? <span className="max-w-full"><label htmlFor={id} className="text-micro">Copy this replay link</label><input ref={input} id={id} readOnly value={fallback} className="block min-h-11 w-64 max-w-full rounded border border-border bg-bg-surface px-2 text-caption text-text" onFocus={(event) => event.currentTarget.select()} /></span> : null}
  </span>;
}

"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { CloudOff, RefreshCcw } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";

interface Props { surface: "profile" | "archive" | "analysis"; reason: "busy" | "outage"; resetHref?: string; onRetry?: () => void }
const TITLE = { profile: "Profile temporarily unavailable", archive: "Replay archive temporarily unavailable", analysis: "Replay analysis temporarily unavailable" };
const fallbackAttempts = new Map<string, number>();

export function PublicUnavailable({ surface, reason, resetHref, onRetry }: Props) {
  const router = useRouter();
  const retry = () => { try { if (onRetry) onRetry(); else router.refresh(); } catch { window.location.reload(); } };
  const title = reason === "busy" ? "Lots of visitors right now" : TITLE[surface];
  return <section className="mx-auto max-w-2xl py-16"><h1 className="sr-only">{title}</h1>
    <EmptyStatePanel size="lg" icon={<CloudOff className="h-6 w-6 text-text-muted" aria-hidden />} title={title}
      description={reason === "busy" ? "Try again in a few seconds." : "We couldn't reach the service just now. Try again in a moment."}
      action={<div className="flex flex-wrap justify-center gap-3"><Button variant="secondary" onClick={retry} iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}>Try again</Button>{resetHref ? <Link href={resetHref} className="inline-flex min-h-11 items-center font-semibold text-accent underline">Back to first page</Link> : null}</div>} />
    {reason === "busy" ? <Suspense fallback={null}><BusyRetry retry={retry} /></Suspense> : null}
  </section>;
}

function BusyRetry({ retry }: { retry: () => void }) {
  const pathname = usePathname(); const search = useSearchParams();
  const url = `${pathname}?${search?.toString() ?? ""}`;
  const [remaining, setRemaining] = useState<number | null>(null);
  const [cycle, setCycle] = useState(0);
  const retryRef = useRef(retry); retryRef.current = retry;
  useEffect(() => {
    const key = `sc2tools.public-retry:${url}`;
    let attempts = 0; let storageAvailable = true;
    try { attempts = Number(window.sessionStorage.getItem(key)) || 0; window.sessionStorage.setItem(key, String(attempts)); }
    catch { storageAvailable = false; attempts = fallbackAttempts.get(key) ?? 0; }
    if (attempts >= (storageAvailable ? 3 : 1)) { setRemaining(null); return; }
    let seconds = 10; setRemaining(seconds);
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      seconds--; setRemaining(seconds);
      if (seconds > 0) return;
      window.clearInterval(timer);
      if (!storageAvailable) fallbackAttempts.set(key, attempts + 1);
      try { window.sessionStorage.setItem(key, String(attempts + 1)); } catch { fallbackAttempts.set(key, attempts + 1); }
      retryRef.current(); setCycle((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [url, cycle]);
  return remaining === null ? null : <p role="status" aria-live="polite" className="text-center text-caption text-text-muted">Retrying in {remaining}…</p>;
}

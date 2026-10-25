"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { fetchReplayCsv, saveReplayCsv } from "@/lib/replayCsvDownload";

export function ReplayCsvExportButton({ query }: { query: string }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  return isLoaded && isSignedIn && userId ? <OwnerExport key={userId} query={query} /> : <Button disabled>Export CSV</Button>;
}

function OwnerExport({ query }: { query: string }) {
  const { getToken } = useAuth();
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const active = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    active.current?.abort(); active.current = null; setPending(false); setMessage("");
    return () => { active.current?.abort(); active.current = null; };
  }, [query]);
  const download = async () => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setPending(true); setMessage("");
    let onAbort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason || new DOMException("Cancelled", "AbortError"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timeout = window.setTimeout(() => controller.abort(new Error("Export timed out. Try a smaller date range.")), 120000);
    try {
      const result = await Promise.race([fetchReplayCsv(getToken, query, controller.signal), cancelled]);
      if (active.current !== controller || controller.signal.aborted) return;
      saveReplayCsv(result.blob);
      setMessage(result.truncated ? "Download started. Export limited to the first 50,000 matching games in the selected sort order; narrow the date range for the rest." : "CSV download started.");
    } catch (error) {
      if (active.current !== controller) return;
      const reason: unknown = controller.signal.aborted ? controller.signal.reason : error;
      setMessage(reason instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : reason instanceof Error && reason.name !== "AbortError" ? reason.message : "Couldn't export your games. Try again.");
    } finally {
      window.clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      if (active.current === controller) { active.current = null; setPending(false); }
    }
  };
  return <div className="min-w-0 space-y-1">
    <div className="flex flex-wrap items-center gap-2"><Button onClick={() => { void download(); }} disabled={pending} aria-busy={pending}>{pending ? "Preparing CSV…" : "Export CSV"}</Button><LazyHelpLink slug="export-csv">CSV columns</LazyHelpLink></div>
    <p className="text-micro text-text-dim">Current filters · up to 50,000 games · once per minute</p>
    {message ? <p role="status" className="max-w-prose text-caption text-text-muted">{message}</p> : null}
  </div>;
}

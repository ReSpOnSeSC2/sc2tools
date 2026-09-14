"use client";

import { Card } from "@/components/ui/Card";
import { useState } from "react";
import type { ClientApiError } from "@/lib/clientApi";

export function TrendsRequestError({
  title,
  retry,
  error,
}: {
  title: string;
  retry: () => unknown;
  error?: ClientApiError;
}) {
  const [retrying, setRetrying] = useState(false);
  async function handleRetry() {
    setRetrying(true);
    try {
      await retry();
    } catch {
      // SWR retains the request error, so the same retry state stays visible.
    } finally {
      setRetrying(false);
    }
  }
  return (
    <Card title={title}>
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-3">
        <p className="text-sm text-text-muted">{error?.code === "request_timeout" || error?.code === "network_unavailable" || error?.code === "global_trends_busy" ? error.message : "This chart could not be loaded."} Your filters are still applied.</p>
        <button type="button" disabled={retrying} aria-busy={retrying} onClick={() => { void handleRetry(); }} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text hover:bg-bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60">
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    </Card>
  );
}

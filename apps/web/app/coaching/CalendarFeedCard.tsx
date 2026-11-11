"use client";

import { formatDate } from "@/lib/i18n/format";
import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { CalendarPlus } from "lucide-react";
import { API_BASE, apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { RequestError } from "@/components/ui/RequestError";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";

type FeedStatus = { active: boolean; createdAt: string | null; path?: string };

/**
 * "Add sessions to your calendar": a private link calendar apps subscribe
 * to. The link is shown once when it is created; afterwards only its date
 * is known, and Regenerate replaces it.
 */
export function CalendarFeedCard() {
  const { getToken } = useAuth();
  const status = useApi<FeedStatus>("/v1/me/calendar-feed");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);
  async function change(method: "POST" | "DELETE") {
    if (busy) return; setBusy(true); setError(null);
    try {
      const result = await apiCall<FeedStatus>(getToken, "/v1/me/calendar-feed", { method });
      setFresh(result.path ? `${API_BASE.replace(/\/+$/, "")}${result.path}` : null);
      await status.mutate({ active: result.active, createdAt: result.createdAt }, { revalidate: false });
    } catch (cause) { setError(cause as ClientApiError); }
    finally { setBusy(false); }
  }
  const data = status.data;
  return <Card>
    <Card.Header className="items-start">
      <div>
        <h2 className="font-display text-h4 font-extrabold text-text">Add sessions to your calendar</h2>
        <p className="mt-1 text-caption text-text-muted">Subscribe once in Google Calendar, Apple Calendar or Outlook and booked sessions appear there, including cancellations. The link shows times only, never other students&apos; names. <LazyHelpLink slug="notifications-on-your-phone" anchor="calendar">How it works</LazyHelpLink></p>
      </div>
      <CalendarPlus className="h-5 w-5 shrink-0 text-accent" aria-hidden />
    </Card.Header>
    <Card.Body className="space-y-3">
      {error ? <RequestError error={error} onRetry={() => setError(null)} /> : null}
      {status.error && !data ? <RequestError error={status.error} onRetry={() => status.mutate()} /> : null}
      {fresh ? <div className="space-y-2 rounded-lg border border-border bg-bg-elevated p-3">
        <p className="text-caption font-semibold text-text">Your private calendar link. Copy it now; for your privacy it is shown only once.</p>
        <p className="break-all font-mono text-caption text-text-muted">{fresh}</p>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={fresh} size="sm" className="min-h-11" successMessage="Calendar link copied" fallbackLabel="Copy your calendar link">Copy link</CopyButton>
          <a href={fresh.replace(/^https?:/, "webcal:")} className="inline-flex min-h-11 items-center rounded-md px-2 text-caption font-semibold text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Open in calendar app</a>
        </div>
      </div> : null}
      {data ? <p className="text-caption text-text-muted">{data.active ? `A calendar link is active (created ${data.createdAt ? formatDate(new Date(data.createdAt)) : "earlier"}).` : "No calendar link yet."}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="min-h-11" disabled={busy || !data} onClick={() => void change("POST")}>{data?.active ? "Regenerate link" : "Create calendar link"}</Button>
        {data?.active ? <Button variant="secondary" size="sm" className="min-h-11" disabled={busy} onClick={() => { setFresh(null); void change("DELETE"); }}>Turn off link</Button> : null}
      </div>
      {data?.active ? <p className="text-caption text-text-muted">Regenerate stops the old link at once. Calendar apps refresh subscribed calendars on their own schedule, often every few hours.</p> : null}
    </Card.Body>
  </Card>;
}

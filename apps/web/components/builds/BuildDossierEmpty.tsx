"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Card, EmptyState } from "@/components/ui/Card";
import { apiCall, useApi } from "@/lib/clientApi";
import type { PendingIntentsResponse } from "@/lib/buildIntent";

const CheckInQueue = lazy(() => import("@/components/build-checkin/BuildCheckInQueue").then((mod) => ({ default: mod.BuildCheckInQueue })));
type MatchingStatus = { status: string; generation?: string; error?: string };
const isActive = (data?: MatchingStatus) => ["queued", "running", "retry"].includes(data?.status ?? "");

/** Only mounted for a verified zero. The heavy queue loads after its action is used. */
export function BuildDossierEmpty({ slug, onEditRules, onMatched }: { slug?: string; onEditRules?: () => void; onMatched: () => void }) {
  const { getToken } = useAuth();
  const status = useApi<MatchingStatus>(slug ? "/v1/custom-builds/reclassify-status" : null, { refreshInterval: (latest) => isActive(latest) ? 1500 : 0, dedupingInterval: 500 });
  const pending = useApi<PendingIntentsResponse>(slug ? "/v1/build-intents/pending?limit=1" : null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const observed = useRef(false);
  const active = isActive(status.data);
  useEffect(() => {
    if (active) { observed.current = true; return; }
    if (!observed.current || !["complete", "failed"].includes(status.data?.status ?? "")) return;
    observed.current = false; setSubmitting(false);
    if (status.data?.status === "complete") { setMessage(""); onMatched(); }
    else setMessage("Replay matching stopped. Your build is safe. Try again.");
  }, [active, status.data?.status, onMatched]);
  const rematch = async () => {
    if (!slug) return;
    setSubmitting(true); setMessage("");
    try {
      const result = await apiCall<{ generation?: string }>(getToken, `/v1/custom-builds/${encodeURIComponent(slug)}/reclassify`, { method: "POST", body: JSON.stringify({ replace: true }) });
      observed.current = true;
      await status.mutate({ status: "queued", generation: result.generation }, { revalidate: true });
    } catch (error) {
      setSubmitting(false);
      const requestId = error && typeof error === "object" && "requestId" in error ? String(error.requestId ?? "") : "";
      setMessage(`Couldn't re-match replays. Try again.${requestId ? ` Error ID: ${requestId}` : ""}`);
    }
  };
  return <>
    <Card><EmptyState title="No games matched this build yet" sub="Builds count games once your replays are matched against the rules. If you just saved it, matching may still be running." />
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {slug ? active || submitting ? <p role="status" className="self-center text-caption text-text-muted">{submitting ? "Re-matching… this can take a minute" : "Matching is running…"}</p> : <Button onClick={() => { void rematch(); }}>Re-match replays</Button> : null}
        {onEditRules ? <Button variant="secondary" onClick={onEditRules}>Edit rules</Button> : null}
        {pending.data && !pending.data.disabled && pending.data.items.length > 0 ? <Button variant="secondary" onClick={() => setQueueOpen(true)}>Review check-ins</Button> : null}
      </div>
      {message || status.data?.status === "failed" ? <p role="alert" className="mt-3 break-words text-center text-caption text-danger">{message || "Replay matching stopped. Your build is safe. Try again."}</p> : null}
      {status.error ? <div className="mt-3 text-center text-caption text-text-muted"><p>Couldn't check whether matching is running.</p><Button variant="secondary" onClick={() => { void status.mutate(); }}>Try again</Button></div> : null}
    </Card>
    {queueOpen ? <Suspense fallback={<p role="status">Loading check-ins…</p>}><CheckInQueue open onClose={() => setQueueOpen(false)} /></Suspense> : null}
  </>;
}

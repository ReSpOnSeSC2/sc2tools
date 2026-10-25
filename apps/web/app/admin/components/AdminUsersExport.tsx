"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { API_BASE, boundedApiRequest, buildApiError } from "@/lib/clientApi";
import { saveReplayCsv } from "@/lib/replayCsvDownload";

export function AdminUsersExport({ query }: { query: string }) {
  const auth = useAuth();
  return auth.isLoaded && auth.isSignedIn && auth.userId ? <OwnerExport key={auth.userId} query={query} /> : <Button disabled>Export CSV</Button>;
}
function OwnerExport({ query }: { query: string }) {
  const { getToken } = useAuth(), active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  useLayoutEffect(() => { active.current?.abort(); active.current = null; setPending(false); setMessage(""); return () => { active.current?.abort(); active.current = null; }; }, [query]);
  const download = async () => {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setPending(true); setMessage("");
    try {
      const result = await boundedApiRequest(async signal => {
        const token = await getToken(); signal.throwIfAborted();
        if (active.current !== controller || controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        if (!token) throw new Error("Sign in again to export users.");
        const response = await fetch(`${API_BASE}/v1/admin/users/export.csv?${query}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal });
        if (!response.ok) throw await buildApiError(response);
        const blob = await response.blob(); signal.throwIfAborted();
        return { blob, truncated: response.headers.get("X-Export-Truncated") === "true" };
      }, 60000, controller.signal);
      if (active.current !== controller || controller.signal.aborted) return;
      saveReplayCsv(result.blob, `sc2tools-users-${new Date().toISOString().slice(0, 10)}.csv`);
      setMessage(result.truncated ? "Download started. Limited to the first 10,000 matching users, latest activity first. Narrow your filters for the rest." : "CSV download started.");
    } catch (error) {
      if (active.current !== controller || controller.signal.aborted) return;
      setMessage(error && typeof error === "object" && "code" in error && error.code === "request_timeout" ? "Export took too long. Narrow the search or account filter, then retry." : error && typeof error === "object" && "message" in error ? String(error.message) : "Couldn't export users. Retry shortly.");
    } finally { if (active.current === controller) { active.current = null; setPending(false); } }
  };
  return <div className="min-w-0 space-y-1"><Button variant="secondary" disabled={pending} aria-busy={pending} onClick={() => void download()}>{pending ? "Preparing CSV…" : "Export CSV"}</Button><p className="text-micro text-text-muted">Matching filters · up to 10,000 users · once per minute</p><p className="text-micro text-text-muted">Counted at export start; rows can change during download.</p>{message ? <p role="status" className="max-w-sm text-caption text-text-muted">{message}</p> : null}</div>;
}

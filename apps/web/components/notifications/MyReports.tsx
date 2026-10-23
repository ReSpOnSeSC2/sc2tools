"use client";

import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { Button } from "@/components/ui/Button";

export type MyReport = { eventId: string; subject: string; message: string; createdAt: string; status: "new" | "looking" | "fixed" | "wontfix"; revision: number; replies: Array<{ id: string; message: string; createdAt: string }> };
export const REPORT_STATUS_LABELS = { new: "New", looking: "Looking into it", fixed: "Fixed", wontfix: "Won't fix" };
export function MyReports() {
  const query = useApi<{ items: MyReport[] }>("/v1/messages/mine", { refreshInterval: 60000, revalidateOnFocus: true });
  return <section id="my-reports" className="scroll-mt-24 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-h3 font-semibold text-text">My reports</h2><Button variant="secondary" size="sm" onClick={() => query.mutate()}>Refresh reports</Button></div>
    <p className="text-caption text-text-muted">Your latest 20 reports and replies from the site admins.</p>
    {query.error ? <RequestError error={query.error} onRetry={() => query.mutate()} /> : !query.data ? <Skeleton rows={3} /> : !query.data.items.length ? <p className="text-body text-text-muted">No reports yet. Use Help & support → Report a problem to send one.</p> : <ul className="space-y-3">{query.data.items.map((report) => <li key={report.eventId}><Card><details><summary className="cursor-pointer rounded text-body font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{report.subject} <span className="text-caption text-accent-cyan">{REPORT_STATUS_LABELS[report.status]}</span></summary><time className="mt-2 block text-caption text-text-dim" dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time><p className="mt-2 whitespace-pre-wrap break-words text-body text-text-muted">{report.message}</p><ol className="mt-3 space-y-3">{report.replies.map((reply) => <li key={reply.id} className="rounded-lg border border-border p-3"><p className="text-caption font-semibold text-text">Reply from SC2 Tools</p><time className="text-micro text-text-dim" dateTime={reply.createdAt}>{new Date(reply.createdAt).toLocaleString()}</time><p className="mt-1 whitespace-pre-wrap break-words text-body text-text-muted">{reply.message}</p></li>)}</ol></details></Card></li>)}</ul>}
  </section>;
}

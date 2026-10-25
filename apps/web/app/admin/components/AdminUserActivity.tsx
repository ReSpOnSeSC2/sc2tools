"use client";
import Link from "next/link";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { AdminEventRow } from "./AdminEventRow";
import type { AdminEventsListResp } from "./adminTypes";

export function AdminUserActivity({ userId }: { userId: string }) {
  const request = useApi<AdminEventsListResp>(`/v1/admin/events?userId=${encodeURIComponent(userId)}&limit=10`);
  const items = request.isPreviousData ? [] : request.data?.items || [];
  return <Card padded={false}><Card.Header><h2 className="text-h3">Recent activity</h2><Link className="text-caption text-accent hover:underline" href={`/admin/notifications?userId=${encodeURIComponent(userId)}&unread=0`}>View all activity →</Link></Card.Header>
    {request.error ? <div className="p-4"><RequestError error={request.error} onRetry={() => request.mutate()} /></div> : request.isLoading || request.isPreviousData ? <p className="p-4 text-caption" role="status">Loading activity…</p> : items.length ? <ul className="divide-y divide-border">{items.map(event => <AdminEventRow compact key={event.eventId} event={event} unread={!event.readAt} onReportUpdated={() => request.mutate()} />)}</ul> : <p className="p-4 text-caption text-text-muted">No retained activity for this user.</p>}
  </Card>;
}

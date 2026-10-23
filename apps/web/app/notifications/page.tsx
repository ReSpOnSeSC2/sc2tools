"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { NotificationItem } from "@/components/notifications/NotificationItem";
import { CATEGORY_LABELS, NOTIFICATION_CATEGORIES, notificationFocus, type NotificationCategory, type NotificationPage } from "@/components/notifications/notificationModel";

export default function NotificationsPage() {
  const { userId } = useAuth();
  return <NotificationsCenter key={userId || "signed-out"} />;
}

function NotificationsCenter() {
  const { getToken } = useAuth();
  const [category, setCategory] = useState<NotificationCategory>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [saving, setSaving] = useState(false);
  const [writeError, setWriteError] = useState<ClientApiError | null>(null);
  const [, tick] = useState(0);
  const params = new URLSearchParams({ limit: "20", kind: category });
  const cursor = cursors.at(-1); if (cursor) params.set("before", cursor);
  if (unreadOnly) params.set("unread", "true");
  const list = useApi<NotificationPage>(`/v1/me/notifications?${params}`, { refreshInterval: 60000 });
  const unread = useApi<{ count: number }>("/v1/me/notifications/unread-count");
  const refresh = useCallback(() => { void list.mutate(); void unread.mutate(); }, [list, unread]);
  useUserSocket(useMemo(() => ({ "notifications:changed": refresh, connect: refresh }), [refresh]));
  useEffect(() => { const timer = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(timer); }, []);
  async function markAll() {
    if (saving) return; setSaving(true); setWriteError(null);
    try { await apiCall(getToken, "/v1/me/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) }); refresh(); }
    catch (error) { setWriteError(error as ClientApiError); }
    finally { setSaving(false); }
  }
  async function markOne(id: string) {
    try { await apiCall(getToken, "/v1/me/notifications/read", { method: "POST", body: JSON.stringify({ ids: [id] }) }); refresh(); }
    catch (error) { setWriteError(error as ClientApiError); }
  }
  return <div className="space-y-5">
    <PageHeader title="Notifications" description="Reviews, coaching, sync updates and replies to your reports. Notifications are kept for 90 days."
      actions={<><Button variant="secondary" disabled={saving || !unread.data?.count} onClick={markAll}>{saving ? "Working…" : "Mark all as read"}</Button><LazyHelpLink slug="notifications" /></>} />
    <div className="flex flex-wrap gap-2" aria-label="Notification kinds">{NOTIFICATION_CATEGORIES.map((kind) => <button key={kind} type="button" aria-pressed={category === kind} onClick={() => { setCategory(kind); setCursors([null]); }} className={`rounded-full border border-border px-3 py-2 text-caption ${notificationFocus} ${category === kind ? "bg-accent/15 text-accent-cyan" : "text-text-muted hover:bg-bg-elevated"}`}>{CATEGORY_LABELS[kind]}</button>)}
      <label className="inline-flex items-center gap-2 px-2 text-caption"><input type="checkbox" checked={unreadOnly} onChange={(e) => { setUnreadOnly(e.target.checked); setCursors([null]); }} />Unread only</label>
    </div>
    {writeError ? <RequestError error={writeError} onRetry={markAll} /> : null}
    {unread.error ? <RequestError title="Unread count unavailable" error={unread.error} onRetry={() => unread.mutate()} /> : null}
    {list.error ? <RequestError error={list.error} onRetry={() => list.mutate()} /> : list.isLoading && !list.data ? <Skeleton rows={4} /> : !list.data?.items.length ? <EmptyStatePanel title={`No ${category === "all" ? "" : CATEGORY_LABELS[category].toLowerCase() + " "}${unreadOnly ? "unread " : ""}notifications`} description="New activity will appear here. You can change which kinds you receive in Settings → Misc." action={<Link className={`rounded-lg px-3 py-2 text-accent-cyan ${notificationFocus}`} href="/settings?tab=misc">Notification settings</Link>} />
      : <Card><ul className="space-y-2">{list.data.items.map((row) => <li key={row.id}><NotificationItem row={row} isNew={!row.readAt} onOpen={() => void markOne(row.id)} /></li>)}</ul></Card>}
    <nav aria-label="Notification pages" className="flex items-center justify-between gap-3">
      <Button variant="secondary" disabled={cursors.length <= 1 || list.isValidating} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous</Button>
      <span className="text-caption text-text-muted">Page {cursors.length}</span>
      <Button variant="secondary" disabled={!list.data?.nextCursor || list.isValidating} onClick={() => { if (list.data?.nextCursor) setCursors((current) => [...current, list.data!.nextCursor]); }}>Next</Button>
    </nav>
  </div>;
}

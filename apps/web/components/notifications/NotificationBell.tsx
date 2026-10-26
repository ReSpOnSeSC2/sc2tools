"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@clerk/nextjs";
import { Bell } from "lucide-react";
import { apiCall, useApi } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";
import { Popover } from "@/components/ui/Popover";
export { notificationPanelPlacement } from "@/lib/a11y/popoverPlacement";
const NotificationPanel = dynamic(() => import("./NotificationPanel"), { ssr: false });

type NotificationRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  count: number;
  readAt: string | null;
  createdAt: string;
};
type NotificationPage = { items: NotificationRow[]; nextCursor: string | null };
type NotificationView = "unread" | "all";

const notificationVersion = (row: NotificationRow) => `${row.id}:${row.createdAt}:${row.count}`;

/**
 * The in-app notification bell (review activity, helpful/best marks,
 * the weekly digest). There is no email channel.
 *
 * The unread count polls slowly and refreshes on the server's
 * ``notifications:changed`` socket ping — a text-free hint, because
 * overlay and agent sockets share the user's room. Opening the panel
 * loads the list and marks what was shown as read.
 */
export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const { userId } = useAuth();
  if (!userId) return null;
  return <Bell_ key={userId || "signed-out"} compact={compact} />;
}

function Bell_({ compact }: { compact: boolean }) {
  const { getToken } = useAuth();
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const [open, setOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const openedNew = useRef(new Set<string>());
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [view, setView] = useState<NotificationView>("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [scopeReady, setScopeReady] = useState(false);
  const [scopeMerged, setScopeMerged] = useState(false);
  const [scopeVersion, setScopeVersion] = useState(0);
  const [readError, setReadError] = useState(false);
  const failedMarkAll = useRef(false);
  const [readRetry, setReadRetry] = useState(0);
  const acknowledged = useRef(new Map<string, string>());
  const pendingReads = useRef(new Set<string>());
  const failedReads = useRef(new Set<string>());
  const loadedHistoryTail = useRef(false);
  const mounted = useRef(true);
  const unread = useApi<{ count: number }>("/v1/me/notifications/unread-count", {
    refreshInterval: 120_000,
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
  const params = new URLSearchParams({ limit: "20" });
  if (view === "unread") params.set("unread", "true");
  if (cursor) params.set("before", cursor);
  const list = useApi<NotificationPage>(open ? `/v1/me/notifications?${params}` : null, {
    revalidateOnFocus: false,
  });
  const mutateUnread = unread.mutate;
  const listRef = useRef(list.mutate);
  listRef.current = list.mutate;
  const openRef = useRef(open);
  openRef.current = open;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const refresh = useCallback(() => {
    void mutateUnread();
    if (openRef.current) {
      // A new notification belongs ahead of any older page cursor. Return
      // to the head while retaining rows the reader already loaded.
      if (cursorRef.current) {
        setCursor(null);
        setScopeVersion((value) => value + 1);
      }
      else void listRef.current();
    }
  }, [mutateUnread]);
  const handlers = useMemo(() => ({ "notifications:changed": refresh, connect: refresh }), [refresh]);
  useUserSocket(handlers);

  const count = unread.data?.count ?? 0;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    // A cached unread page may contain rows read during an earlier mount.
    // Start each opening/view with a fresh response before retaining rows.
    void listRef.current().then((page) => {
      if (current && page) setScopeReady(true);
    }).catch(() => {});
    return () => { current = false; };
  }, [open, view, scopeVersion]);

  useEffect(() => {
    if (!open || !scopeReady || !list.data || list.error) return;
    // A read acknowledgement changes the server's unread result. Keep the
    // rows already shown until this panel closes or its view changes.
    const page = list.data;
    setItems((previous) => {
      const rows = new Map(previous.map((row) => [row.id, row]));
      for (const row of page.items) {
        const readAt = acknowledged.current.get(notificationVersion(row));
        // A warm unread cache may predate our acknowledgement. Retain a
        // currently visible row, but do not resurrect it in a fresh view.
        if (view === "unread" && readAt && !rows.has(row.id)) continue;
        rows.set(row.id, readAt ? { ...row, readAt } : row);
      }
      return [...rows.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    });
    setScopeMerged(true);
    if (view !== "all" || cursor || !loadedHistoryTail.current) {
      setNextCursor(page.nextCursor);
    }
    if (view === "all" && cursor) loadedHistoryTail.current = true;
  }, [open, scopeReady, list.data, list.error, cursor, view]);

  useEffect(() => {
    if (!open) return;
    const batch = items.filter((row) => {
      const version = notificationVersion(row);
      if (!row.readAt) openedNew.current.add(row.id);
      return !row.readAt && !acknowledged.current.has(version)
        && !pendingReads.current.has(version) && !failedReads.current.has(version);
    });
    if (!batch.length) return;
    const versions = batch.map(notificationVersion);
    versions.forEach((version) => pendingReads.current.add(version));
    void apiCall(tokenRef.current, "/v1/me/notifications/read", {
      method: "POST", body: JSON.stringify({ ids: batch.map((row) => row.id) }),
    }).then(() => {
      if (!mounted.current) return;
      const readAt = new Date().toISOString();
      versions.forEach((version) => acknowledged.current.set(version, readAt));
      setItems((current) => current.map((row) =>
        versions.includes(notificationVersion(row)) ? { ...row, readAt } : row));
      void mutateUnread();
    }).catch(() => {
      if (!mounted.current) return;
      versions.forEach((version) => failedReads.current.add(version));
      setReadError(true);
    }).finally(() => {
      versions.forEach((version) => pendingReads.current.delete(version));
    });
  }, [open, items, mutateUnread, readRetry]);

  function selectView(next: NotificationView) {
    loadedHistoryTail.current = false;
    setScopeReady(false);
    setScopeMerged(false);
    setScopeVersion((value) => value + 1);
    setItems([]);
    setCursor(null);
    setNextCursor(null);
    setView(next);
  }

  function closePanel() { setOpen(false); }
  function togglePanel() {
    if (!open) { openedNew.current.clear(); selectView(count > 0 ? "unread" : "all"); setOpen(true); }
    else closePanel();
  }
  async function markAllRead() {
    if (markingAll || count === 0) return;
    failedMarkAll.current = false;
    setMarkingAll(true);
    try {
      await apiCall(tokenRef.current, "/v1/me/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) });
      if (!mounted.current) return;
      const readAt = new Date().toISOString();
      setItems((current) => current.map((row) => { acknowledged.current.set(notificationVersion(row), readAt); return { ...row, readAt }; }));
      setReadError(false); void mutateUnread();
    } catch { if (mounted.current) { failedMarkAll.current = true; setReadError(true); } }
    finally { if (mounted.current) setMarkingAll(false); }
  }

  return (
    <div className="relative">
      <button
        ref={bellRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={count ? `Notifications, ${count} unread` : "Notifications"}
        onClick={togglePanel}
        className={[
          "hard-press relative inline-flex items-center justify-center rounded-full border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          compact ? "h-8 min-w-8 px-2" : "h-9 min-w-9 px-2.5",
        ].join(" ")}
      >
        <Bell className={`h-4 w-4 ${unread.error ? "text-text-dim" : ""}`} aria-hidden />
        {count > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 grid min-h-5 min-w-5 place-items-center rounded-full border-2 border-bg bg-danger px-1 font-mono text-[10px] font-bold leading-none text-white">
            {count > 99 ? "99+" : String(count)}
          </span>
        ) : null}
      </button>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus -- The lazy panel focuses its first row only after the fresh page is ready and merged. */}
      <Popover open={open} onClose={closePanel} anchorRef={bellRef} label="Notifications" id={panelId} autoFocus={false} className="border-2 border-line !p-2">
      {open ? <NotificationPanel items={items} ready={scopeReady && scopeMerged} loading={!!(list.isLoading || list.isValidating)}
        listError={!!list.error} unreadError={!!unread.error} readError={readError} view={view} selectView={selectView} onClose={closePanel}
        retryList={() => { if (!scopeReady) setScopeVersion((value) => value + 1); else void list.mutate(); }}
        retryUnread={() => void mutateUnread()} retryRead={() => { if (failedMarkAll.current) { void markAllRead(); return; } failedReads.current.clear(); setReadError(false); setReadRetry((value) => value + 1); }}
        onMore={nextCursor ? () => setCursor(nextCursor) : null} markAll={markAllRead} markingAll={markingAll} unread={count} openedNew={openedNew.current} /> : null}
      </Popover>
    </div>
  );
}

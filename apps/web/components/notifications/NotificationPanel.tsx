"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { SkeletonBar, SkeletonRegion } from "@/components/ui/Skeleton";
import { NotificationItem } from "./NotificationItem";
import { CATEGORY_LABELS, NOTIFICATION_CATEGORIES, notificationCategory, notificationFocus, type NotificationCategory, type NotificationRow } from "./notificationModel";

type Props = {
  items: NotificationRow[]; style?: CSSProperties; ready: boolean; loading: boolean;
  listError: boolean; unreadError: boolean; readError: boolean; view: "all" | "unread";
  selectView: (view: "all" | "unread") => void; onClose: () => void;
  retryList: () => void; retryUnread: () => void; retryRead: () => void;
  onMore: (() => void) | null; markAll: () => void; markingAll: boolean; unread: number; openedNew: Set<string>;
};

export default function NotificationPanel(p: Props) {
  const [category, setCategory] = useState<NotificationCategory>("all");
  const [, tick] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLHeadingElement>(null);
  const focused = useRef(false);
  const items = p.items.filter((row) => category === "all" || notificationCategory(row.kind) === category);
  useEffect(() => { const timer = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (focused.current || (!p.ready && !p.listError && !p.unreadError)) return;
    // The parent merges its freshly loaded page in an effect. Focus after
    // that merge, rather than treating its transient empty render as final.
    const timer = setTimeout(() => {
      (panel.current?.querySelector<HTMLElement>("[data-notification-row]") || header.current)?.focus();
      focused.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, [p.ready, p.items, p.listError, p.unreadError]);
  return <div ref={panel} role="dialog" aria-label="Notifications" style={p.style}
    className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border-2 border-line bg-bg-surface p-2 shadow-hard">
    <div className="flex items-center justify-between gap-2 px-2 py-2">
      <h2 ref={header} tabIndex={-1} className="rounded text-body font-semibold text-text">Notifications</h2>
      <button type="button" disabled={p.markingAll || p.unread === 0} onClick={p.markAll} className={`rounded px-1 text-caption text-accent-cyan disabled:text-text-dim ${notificationFocus}`}>{p.markingAll ? "Working…" : "Mark all read"}</button>
    </div>
    <div className="mb-2 flex gap-1 rounded-lg border border-border p-1">
      {(["unread", "all"] as const).map((mode) => <button key={mode} type="button" aria-pressed={p.view === mode}
        onClick={() => { setCategory("all"); p.selectView(mode); }}
        className={`flex-1 rounded-md px-2 py-1 text-caption font-semibold ${notificationFocus} ${p.view === mode ? "bg-accent/15 text-accent-cyan" : "text-text-muted hover:bg-bg-elevated"}`}>{mode === "unread" ? "Unread" : "All notifications"}</button>)}
    </div>
    <div className="mb-2 flex flex-wrap gap-1 px-1" aria-label="Notification kinds">
      {NOTIFICATION_CATEGORIES.filter((kind) => kind === "all" || p.items.some((row) => notificationCategory(row.kind) === kind)).map((kind) => <button key={kind} type="button" aria-pressed={category === kind} onClick={() => setCategory(kind)} className={`rounded-full px-2 py-1 text-micro ${notificationFocus} ${category === kind ? "bg-accent/15 text-accent-cyan" : "text-text-muted hover:bg-bg-elevated"}`}>{CATEGORY_LABELS[kind]}</button>)}
    </div>
    {p.unreadError ? <ErrorRow message="Couldn't load notifications ·" retry={p.retryUnread} /> : null}
    {p.readError ? <ErrorRow message="Could not mark notifications as read." retry={p.retryRead} /> : null}
    {p.listError ? <ErrorRow message="Could not load notifications." retry={p.retryList} label="Try again" /> : null}
    {(!p.ready || p.loading) && !p.listError && !p.items.length ? <SkeletonRegion label="Loading notifications" className="space-y-1">{[0, 1, 2].map((i) => <div key={i} className="space-y-2 p-2"><SkeletonBar className="h-3 w-3/5" /><SkeletonBar className="h-2.5 w-4/5" /></div>)}</SkeletonRegion>
      : !items.length && !p.listError ? <p className="p-3 text-caption text-text-muted">{category !== "all" ? `No ${CATEGORY_LABELS[category].toLowerCase()} notifications in this view.` : p.view === "unread" ? "No unread notifications." : "No notifications yet."}</p>
        : <ul className="max-h-[60vh] space-y-1 overflow-y-auto">{items.map((row, i) => {
          const today = new Date(row.createdAt).toDateString() === new Date().toDateString();
          const previousToday = i > 0 && new Date(items[i - 1].createdAt).toDateString() === new Date().toDateString();
          return <li key={row.id}>{i === 0 || today !== previousToday ? <h3 className="px-2 py-1 text-micro font-semibold text-text-dim">{today ? "Today" : "Earlier"}</h3> : null}<NotificationItem row={row} isNew={p.openedNew.has(row.id) || !row.readAt} onOpen={p.onClose} /></li>;
        })}</ul>}
    {p.onMore ? <button type="button" disabled={p.loading} onClick={p.onMore} className={`mt-1 w-full rounded-lg p-2 text-caption font-semibold hover:bg-bg-elevated disabled:opacity-50 ${notificationFocus}`}>{p.loading ? "Loading…" : "Load more notifications"}</button> : null}
    <Link href="/notifications" onClick={p.onClose} className={`mt-2 block rounded-lg border-t border-border p-2 text-center text-caption font-semibold text-accent-cyan ${notificationFocus}`}>See all notifications</Link>
  </div>;
}

function ErrorRow({ message, retry, label = "Retry" }: { message: string; retry: () => void; label?: string }) {
  return <p role="alert" className="p-2 text-caption text-text-muted">{message} <button type="button" onClick={retry} className={`rounded underline ${notificationFocus}`}>{label}</button></p>;
}

"use client";

import Link from "next/link";
import { Bell, CalendarClock, Download, MessageSquareText, ThumbsUp, MonitorUp } from "lucide-react";
import { fmtAgo, notificationFocus, type NotificationRow } from "./notificationModel";

export function NotificationItem({ row, isNew = false, onOpen }: { row: NotificationRow; isNew?: boolean; onOpen?: () => void }) {
  const Icon = row.kind.startsWith("coaching.") ? CalendarClock : row.kind === "import.done" ? Download
    : row.kind === "agent.update_required" ? MonitorUp : row.kind === "community.vote" ? ThumbsUp
      : row.kind.startsWith("review.") || row.kind.startsWith("support.") ? MessageSquareText : Bell;
  return <Link data-notification-row href={row.href || "/notifications"} onClick={onOpen}
    className={`flex gap-2 rounded-lg p-2.5 hover:bg-bg-elevated ${notificationFocus} ${isNew ? "bg-accent/10" : ""}`}>
    <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-accent-cyan" />
    <span className="min-w-0 flex-1"><span className="block break-words text-caption font-semibold text-text">{row.title}
      {isNew ? <span className="ml-2 inline-flex items-center gap-1 text-micro text-accent-cyan"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-cyan" />New</span> : null}</span>
      {row.body ? <span className="block break-words text-micro text-text-muted">{row.body}</span> : null}
      <time className="block text-micro text-text-dim" dateTime={row.createdAt} title={new Date(row.createdAt).toLocaleString()}>{fmtAgo(row.createdAt)}</time>
    </span>
  </Link>;
}

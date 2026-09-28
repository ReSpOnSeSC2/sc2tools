"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Bell } from "lucide-react";
import { apiCall, useApi } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";
import { reviewsVisible } from "@/lib/reviews";

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
  // Every current notification comes from the Replay Review Exchange,
  // so the bell follows its rollout (SWR dedupes /v1/me app-wide).
  const { data: me } = useApi<{ isAdmin?: boolean }>("/v1/me");
  if (!reviewsVisible(me?.isAdmin)) return null;
  return <Bell_ compact={compact} />;
}

/** Gap kept between the panel and the viewport edges, in px. */
const PANEL_GUTTER = 16;
/** Preferred panel width (22rem) — narrower viewports shrink it. */
const PANEL_MAX_WIDTH = 352;

/**
 * Where the dropdown sits, relative to the bell's wrapper. Right-aligning
 * to the bell only works when the bell is the right-most header control;
 * on phones the theme toggle and avatar sit to its right, so a
 * right-aligned panel spills off the left edge. Clamp it inside the
 * viewport instead.
 */
export function notificationPanelPlacement(
  anchor: { left: number; right: number },
  viewportWidth: number,
): { left: number; width: number } {
  const width = Math.max(0, Math.min(PANEL_MAX_WIDTH, viewportWidth - PANEL_GUTTER * 2));
  const maxLeft = viewportWidth - PANEL_GUTTER - width;
  const viewportLeft = Math.min(Math.max(anchor.right - width, PANEL_GUTTER), maxLeft);
  return { left: viewportLeft - anchor.left, width };
}

function Bell_({ compact }: { compact: boolean }) {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | undefined>(undefined);
  const unread = useApi<{ count: number }>("/v1/me/notifications/unread-count", {
    refreshInterval: 120_000,
    revalidateOnFocus: true,
    shouldRetryOnError: false,
  });
  const list = useApi<{ items: NotificationRow[] }>(open ? "/v1/me/notifications?limit=20" : null, {
    revalidateOnFocus: false,
  });
  const refresh = useCallback(() => {
    void unread.mutate();
    if (open) void list.mutate();
  }, [unread, list, open]);
  const handlers = useMemo(() => ({ "notifications:changed": () => refresh() }), [refresh]);
  // Only sockets for accounts the API answered for (signed in, feature on).
  useUserSocket(unread.data ? handlers : null);

  const count = unread.data?.count ?? 0;
  const items = list.data?.items;
  useEffect(() => {
    if (!open || !items) return;
    const ids = items.filter((n) => !n.readAt).map((n) => n.id);
    if (ids.length === 0) return;
    void apiCall(getToken, "/v1/me/notifications/read", { method: "POST", body: JSON.stringify({ ids }) })
      .then(() => unread.mutate())
      .catch(() => {});
  }, [open, items, getToken, unread]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = rootRef.current;
      if (!el) return;
      const { left, width } = notificationPanelPlacement(
        el.getBoundingClientRect(),
        document.documentElement.clientWidth || window.innerWidth,
      );
      setPanelStyle({ left, width });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  if (unread.error || !unread.data) return null;
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count ? `Notifications, ${count} unread` : "Notifications"}
        onClick={() => setOpen((v) => !v)}
        className={[
          "hard-press relative inline-flex items-center justify-center rounded-full border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          compact ? "h-8 min-w-8 px-2" : "h-9 min-w-9 px-2.5",
        ].join(" ")}
      >
        <Bell className="h-4 w-4" aria-hidden />
        {count > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 grid min-h-5 min-w-5 place-items-center rounded-full border-2 border-bg bg-danger px-1 font-mono text-[10px] font-bold leading-none text-white">
            {count > 99 ? "99+" : String(count)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          style={panelStyle}
          className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border-2 border-line bg-bg-surface p-2 shadow-hard"
        >
          {!items ? (
            <p className="p-3 text-caption text-text-muted">Loading…</p>
          ) : items.length === 0 ? (
            <p className="p-3 text-caption text-text-muted">No notifications yet.</p>
          ) : (
            <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <Link
                    href={n.href || "/reviews"}
                    onClick={() => setOpen(false)}
                    className={`block rounded-lg p-2.5 hover:bg-bg-elevated ${n.readAt ? "" : "bg-accent/10"}`}
                  >
                    <span className="block text-caption font-semibold text-text">{n.title}</span>
                    {n.body ? <span className="block break-words text-micro text-text-muted">{n.body}</span> : null}
                    <time className="block text-micro text-text-dim" dateTime={n.createdAt}>{new Date(n.createdAt).toLocaleString()}</time>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

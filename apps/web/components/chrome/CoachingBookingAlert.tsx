"use client";

import Link from "next/link";
import { BellRing } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useApi } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";
import { useToastOptional } from "@/components/ui/Toast";

type AlertSummary = {
  eligible: boolean;
  unreadCount: number;
  alert: null | {
    kind: "booked" | "cancelled";
    title: string;
    message: string;
    startAt: string;
  };
};

/**
 * Durable coaching alert entry point shared by both application shells.
 * It stays completely absent for users outside Coaching and appears only
 * when a coach/student has an unread scheduling event.
 */
export function CoachingBookingAlert({ compact = false }: { compact?: boolean }) {
  const { data, mutate } = useApi<AlertSummary>("/v1/coaching/alerts", {
    // One probe for everyone, then polling only for actual coaching members.
    // This preserves the private/quiet route without adding background traffic
    // for the rest of the signed-in user base.
    // Keep a slow recovery probe while eligibility is unknown (for example
    // during a cold-start outage); stop only after the API explicitly says
    // this account is outside Coaching.
    refreshInterval: (latest) => latest?.eligible === false ? 0 : 60_000,
    revalidateOnFocus: true,
    shouldRetryOnError: true,
    errorRetryCount: 3,
  });
  const toastContext = useToastOptional();
  const toastRef = useRef(toastContext);
  toastRef.current = toastContext;

  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);

  const socketHandlers = useMemo(
    () => ({
      "coaching:booking": () => {
        refresh();
        window.dispatchEvent(new Event("coaching:booking-realtime"));
        toastRef.current?.toast.info("Coaching schedule updated", {
          description: "Open Coaching to review the booking.",
        });
      },
    }),
    [refresh],
  );
  useUserSocket(data?.eligible ? socketHandlers : null);

  useEffect(() => {
    window.addEventListener("coaching:alerts-read", refresh);
    return () => window.removeEventListener("coaching:alerts-read", refresh);
  }, [refresh]);

  if (!data?.eligible || data.unreadCount < 1) return null;

  const count = data.unreadCount > 99 ? "99+" : String(data.unreadCount);
  const label = data.alert?.title ?? "Coaching schedule update";

  return (
    <Link
      href="/coaching?view=schedule"
      aria-label={`${label}. ${data.unreadCount} unread. Open Coaching.`}
      title={`${label} — open Coaching`}
      className={[
        "hard-press relative inline-flex items-center justify-center gap-2 rounded-full",
        "border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        compact ? "h-8 min-w-8 px-2" : "h-9 min-w-9 px-2.5",
      ].join(" ")}
    >
      <BellRing className="h-4 w-4 text-accent" aria-hidden />
      <span className="hidden max-w-40 truncate font-display text-caption font-bold text-text 2xl:inline">
        {label}
      </span>
      <span className="absolute -right-1.5 -top-1.5 grid min-h-5 min-w-5 place-items-center rounded-full border-2 border-bg bg-danger px-1 font-mono text-[10px] font-bold leading-none text-white">
        {count}
      </span>
    </Link>
  );
}

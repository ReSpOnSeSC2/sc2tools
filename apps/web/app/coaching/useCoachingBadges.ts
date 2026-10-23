"use client";

import { useEffect } from "react";
import { useApi } from "@/lib/clientApi";
import type { CoachingRole, PracticeSharingPayload } from "./coachingPracticeModel";

/** Same resource keys as Practice and the booking alert; SWR shares their reads. */
export function useCoachingBadges(role?: CoachingRole | "none") {
  const eligible = role && role !== "none";
  const sharing = useApi<PracticeSharingPayload>(eligible ? "/v1/coaching/practice-sharing" : null, { revalidateOnFocus: true, refreshInterval: 30_000 });
  const alerts = useApi<{ unreadCount: number }>(eligible ? "/v1/coaching/alerts" : null, { revalidateOnFocus: true, refreshInterval: 30_000 });
  const mutateAlerts = alerts.mutate;
  useEffect(() => {
    if (!eligible) return;
    const refresh = () => { void mutateAlerts(); };
    window.addEventListener("coaching:alerts-read", refresh);
    window.addEventListener("coaching:booking-realtime", refresh);
    return () => { window.removeEventListener("coaching:alerts-read", refresh); window.removeEventListener("coaching:booking-realtime", refresh); };
  }, [eligible, mutateAlerts]);
  return {
    practice: role === "student" ? (sharing.data?.relationships ?? []).filter((relationship) => relationship.status === "pending").length : 0,
    sessions: Math.max(0, alerts.data?.unreadCount ?? 0),
    relationships: sharing.data?.relationships,
  };
}

"use client";

import { useEffect } from "react";
import { useApi } from "@/lib/clientApi";
import type { AssignmentsPayload, CoachingRole, PracticeSharingPayload } from "./coachingPracticeModel";
import { practiceRoster } from "./coachingPracticeProgress";

/** Same resource keys as Practice and the booking alert; SWR shares their reads. */
export function useCoachingBadges(role?: CoachingRole | "none") {
  const eligible = role && role !== "none";
  const sharing = useApi<PracticeSharingPayload>(eligible ? "/v1/coaching/practice-sharing" : null, { revalidateOnFocus: true, refreshInterval: 30_000 });
  const alerts = useApi<{ unreadCount: number }>(eligible ? "/v1/coaching/alerts" : null, { revalidateOnFocus: true, refreshInterval: 30_000 });
  const assignments = useApi<AssignmentsPayload>(role === "coach" || role === "admin" ? "/v1/coaching/assignments?state=active&limit=100" : null, { revalidateOnFocus: true, refreshInterval: 30_000, keepPreviousData: false }, { timeoutMs: 20_000 });
  const plans = assignments.error || assignments.isPreviousData ? [] : assignments.data?.assignments ?? [];
  const students = Array.from(new Map(plans.map(plan => [plan.student.id, plan.student])).values());
  const behind = practiceRoster(students, plans, Date.parse(assignments.data?.serverTime ?? "")).filter(row => row.behind.length > 0).length;
  const mutateAlerts = alerts.mutate;
  useEffect(() => {
    if (!eligible) return;
    const refresh = () => { void mutateAlerts(); };
    window.addEventListener("coaching:alerts-read", refresh);
    window.addEventListener("coaching:booking-realtime", refresh);
    return () => { window.removeEventListener("coaching:alerts-read", refresh); window.removeEventListener("coaching:booking-realtime", refresh); };
  }, [eligible, mutateAlerts]);
  return {
    practice: role === "student" ? (sharing.data?.relationships ?? []).filter((relationship) => relationship.status === "pending").length : behind,
    practicePartial: !!assignments.data?.hasMore,
    sessions: Math.max(0, alerts.data?.unreadCount ?? 0),
    relationships: sharing.data?.relationships,
  };
}

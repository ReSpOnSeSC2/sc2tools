"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, LockKeyhole, PanelsTopLeft, Target } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import LockerHost from "./LockerHost";
import CoachingPractice from "./CoachingPractice";
import CoachingSchedule from "./CoachingSchedule";
import { useCoachingBadges } from "./useCoachingBadges";

type CoachingMe = {
  role: "admin" | "coach" | "student" | "none";
  coachId: string | null;
  studentId: string | null;
};

type WorkspaceView = "locker" | "practice" | "sessions";

export default function CoachingWorkspace() {
  const { data, error, isLoading, mutate } = useApi<CoachingMe>("/v1/coaching/me");
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeView: WorkspaceView =
    searchParams.get("view") === "practice"
      ? "practice"
      : searchParams.get("view") === "schedule" ||
    searchParams.get("section") === "sessions" ||
    searchParams.has("booking")
      ? "sessions"
      : "locker";
  const [view, setView] = useState<WorkspaceView>(routeView);
  const [lockerActivated, setLockerActivated] = useState(routeView === "locker");
  const [sessionsActivated, setSessionsActivated] = useState(routeView === "sessions");
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const badges = useCoachingBadges(data?.role);

  useEffect(() => {
    setView(routeView);
    if (routeView === "locker") setLockerActivated(true);
    if (routeView === "sessions") setSessionsActivated(true);
  }, [routeView]);

  if (isLoading || (!data && !error)) {
    return <CoachingShellSkeleton />;
  }

  if (error) {
    return (
      <Card className="mx-auto max-w-xl">
        <div className="py-8 text-center">
          <h1 className="font-display text-h3 font-extrabold text-text">
            Coaching could not load
          </h1>
          <p className="mx-auto mt-2 max-w-md text-body text-text-muted">
            Your access was not changed. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => void mutate()}
            className="mt-5 min-h-10 rounded-full border-2 border-line bg-bg-surface px-5 font-display text-caption font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Try again
          </button>
        </div>
      </Card>
    );
  }

  if (!data || data.role === "none") {
    return (
      <Card className="mx-auto max-w-xl">
        <div className="py-8 text-center">
          <LockKeyhole className="mx-auto h-8 w-8 text-text-muted" aria-hidden />
          <h2 className="mt-4 font-display text-h3 font-extrabold text-text">
            Private coaching
          </h2>
          <p className="mx-auto mt-2 max-w-md text-body text-text-muted">
            This workspace is invite-only. Ask your coach to attach the
            sc2tools.com account you are currently signed in with.
          </p>
          <LazyHelpLink
            slug="coaching"
            anchor="roles-and-linking"
            className="mt-3 inline-flex min-h-11 items-center text-caption font-semibold"
          >
            How coaching access works
          </LazyHelpLink>
        </div>
      </Card>
    );
  }

  const selectView = (next: WorkspaceView) => {
    setView(next);
    if (next === "locker") setLockerActivated(true);
    if (next === "sessions") setSessionsActivated(true);
    const href =
      next === "sessions"
        ? "/coaching?view=schedule"
        : next === "practice"
          ? "/coaching?view=practice"
          : "/coaching";
    router.replace(href, { scroll: false });
  };
  const relationships = badges.relationships;
  const description = !relationships ? undefined : data.role === "student" ? relationships[0]?.coach.name ? `with ${relationships[0].coach.name}` : undefined : `${new Set(relationships.map((relationship) => relationship.student.id)).size} students · ${relationships.filter((relationship) => relationship.status === "accepted").length} sharing practice`;

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Private coaching" title={<span className="inline-flex flex-wrap items-center gap-3">Coaching <Badge variant="accent">{data.role === "admin" ? "Admin" : data.role === "coach" ? "Coach" : "Student"}</Badge></span>} description={description} actions={<LazyHelpLink slug="coaching" className="inline-flex min-h-11 items-center text-caption font-semibold">How coaching works</LazyHelpLink>} />
      <Tabs value={view} onValueChange={(next) => selectView(next as WorkspaceView)}>
        <Tabs.List ariaLabel="Coaching workspace" className="flex-nowrap">
          <Tabs.Trigger value="locker"><span className="inline-flex items-center gap-2"><PanelsTopLeft className="h-4 w-4" aria-hidden />Locker</span></Tabs.Trigger>
          <Tabs.Trigger value="practice"><span className="inline-flex items-center gap-2"><Target className="h-4 w-4" aria-hidden />Practice {badges.practice ? <span className="rounded-full bg-warning/15 px-1.5 text-micro text-warning"><span aria-hidden>{badges.practice}{badges.practicePartial ? "+" : ""}</span><span className="sr-only">{badges.practicePartial ? "At least " : ""}{badges.practice} {data.role === "student" ? `practice-sharing request${badges.practice === 1 ? "" : "s"} waiting` : `player${badges.practice === 1 ? "" : "s"} behind schedule`}</span></span> : null}</span></Tabs.Trigger>
          <Tabs.Trigger value="sessions"><span className="inline-flex items-center gap-2"><CalendarClock className="h-4 w-4" aria-hidden />Sessions {badges.sessions ? <span className="rounded-full bg-accent/15 px-1.5 text-micro"><span aria-hidden>{badges.sessions}</span><span className="sr-only">{badges.sessions} unread session alerts</span></span> : null}{scheduleDirty ? <span className="h-2 w-2 rounded-full bg-warning"><span className="sr-only">Unpublished availability changes</span></span> : null}</span></Tabs.Trigger>
        </Tabs.List>

      {/* The legacy Locker script declares global lexical bindings. Keep its
          host mounted while switching sections so returning to Locker never
          re-executes/redeclares that bundle. */}
      {lockerActivated ? (
        <Tabs.Content value="locker" keepMounted>
          <LockerHost />
        </Tabs.Content>
      ) : null}
      <Tabs.Content value="practice"><CoachingPractice role={data.role} /></Tabs.Content>
      {sessionsActivated ? <Tabs.Content value="sessions" keepMounted><CoachingSchedule onDirtyChange={setScheduleDirty} active={view === "sessions"} /></Tabs.Content> : null}
      </Tabs>
    </div>
  );
}

export function CoachingShellSkeleton() {
  return <div role="region" aria-busy="true" aria-label="Loading coaching workspace" className="space-y-4"><div className="h-20 animate-pulse rounded-xl border-2 border-line bg-bg-surface" /><div className="flex gap-2">{[0, 1, 2].map((item) => <div key={item} className="h-11 w-28 animate-pulse rounded-full bg-bg-elevated" />)}</div><div className="h-72 animate-pulse rounded-xl border-2 border-line bg-bg-surface" /></div>;
}

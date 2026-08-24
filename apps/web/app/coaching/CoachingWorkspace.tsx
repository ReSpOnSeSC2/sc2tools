"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, LockKeyhole, PanelsTopLeft } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import LockerHost from "./LockerHost";
import CoachingSchedule from "./CoachingSchedule";

type CoachingMe = {
  role: "admin" | "coach" | "student" | "none";
  coachId: string | null;
  studentId: string | null;
};

type WorkspaceView = "locker" | "sessions";

export default function CoachingWorkspace() {
  const { data, error, isLoading, mutate } = useApi<CoachingMe>("/v1/coaching/me");
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeView: WorkspaceView =
    searchParams.get("view") === "schedule" ||
    searchParams.get("section") === "sessions" ||
    searchParams.has("booking")
      ? "sessions"
      : "locker";
  const [view, setView] = useState<WorkspaceView>(routeView);
  const [lockerActivated, setLockerActivated] = useState(routeView === "locker");

  useEffect(() => {
    setView(routeView);
    if (routeView === "locker") setLockerActivated(true);
  }, [routeView]);

  if (isLoading || (!data && !error)) {
    return (
      <div className="space-y-4" aria-label="Loading coaching workspace">
        <div className="h-14 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
        <div className="h-72 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
      </div>
    );
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
        </div>
      </Card>
    );
  }

  const selectView = (next: WorkspaceView) => {
    setView(next);
    if (next === "locker") setLockerActivated(true);
    const href = next === "sessions" ? "/coaching?view=schedule" : "/coaching";
    router.replace(href, { scroll: false });
  };

  return (
    <div className="space-y-5">
      <h1 className="sr-only">Coaching</h1>
      <nav
        aria-label="Coaching workspace"
        className="flex w-full gap-1 rounded-xl border-2 border-line bg-bg-surface p-1 shadow-hard sm:w-fit"
      >
        <WorkspaceTab
          active={view === "locker"}
          onClick={() => selectView("locker")}
          icon={<PanelsTopLeft className="h-4 w-4" aria-hidden />}
        >
          Locker
        </WorkspaceTab>
        <WorkspaceTab
          active={view === "sessions"}
          onClick={() => selectView("sessions")}
          icon={<CalendarClock className="h-4 w-4" aria-hidden />}
        >
          Sessions
        </WorkspaceTab>
      </nav>

      {/* The legacy Locker script declares global lexical bindings. Keep its
          host mounted while switching sections so returning to Locker never
          re-executes/redeclares that bundle. */}
      {lockerActivated ? (
        <div className={view === "locker" ? "" : "hidden"} aria-hidden={view !== "locker"}>
          <LockerHost />
        </div>
      ) : null}
      {view === "sessions" ? <CoachingSchedule /> : null}
    </div>
  );
}

function WorkspaceTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={[
        "flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg px-4",
        "font-display text-caption font-bold transition-colors sm:flex-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active
          ? "bg-accent text-white"
          : "text-text-muted hover:bg-bg-elevated hover:text-text",
      ].join(" ")}
    >
      {icon}
      {children}
    </button>
  );
}

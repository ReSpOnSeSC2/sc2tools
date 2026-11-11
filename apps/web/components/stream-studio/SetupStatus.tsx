"use client";

import { useAuth } from "@clerk/nextjs";
import { useStreamReadiness } from "@/lib/useStreamReadiness";
import { CrashCourse } from "./CrashCourse";
import { StreamReadinessChecks, type CheckListProps } from "./StreamReadinessChecks";

export function StreamStudioCourse() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const owner = isLoaded && isSignedIn && userId ? userId : null;
  const setup = useStreamReadiness(Boolean(owner));
  return <>
    {owner ? <SetupStatus checks={setup.checks} retry={setup.retry} /> : null}
    <CrashCourse setup={owner ? { owner, checks: setup.checks, starterWidgets: setup.starterWidgets } : undefined} />
  </>;
}

function SetupStatus(props: CheckListProps) {
  return <section aria-labelledby="stream-setup-heading" className="mt-10 space-y-3 rounded-md border-2 border-line bg-bg-surface p-4 sm:p-6">
    <h2 id="stream-setup-heading" className="text-body-lg font-semibold">Your setup</h2>
    <StreamReadinessChecks {...props} />
  </section>;
}

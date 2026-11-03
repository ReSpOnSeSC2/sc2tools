"use client";

import { lazy, Suspense, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import type { GuideTimings } from "@/lib/guides/types";
import { GuideSignInPrompt } from "../GuideSignInPrompt";

const PersonalTimingsTable = lazy(() => import("./PersonalTimingsTable").then((module) => ({ default: module.PersonalTimingsTable })));

export function TimingsTable({ community, ...props }: { timings: GuideTimings; matchupSlug: string; buildSlug: string; community: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) return <Suspense fallback={community}><PersonalTimingsTable {...props} /></Suspense>;
  return <div className="space-y-3">{isLoaded ? <GuideSignInPrompt hasTimings /> : null}{community}</div>;
}

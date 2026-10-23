"use client";

import { lazy, Suspense } from "react";
import { useAuth } from "@clerk/nextjs";
import type { GuideTimings } from "@/lib/guides/types";
import { GuideSignInPrompt } from "../GuideSignInPrompt";
import { TimingsTableContent } from "./TimingsTableContent";

const PersonalTimingsTable = lazy(() => import("./PersonalTimingsTable").then((module) => ({ default: module.PersonalTimingsTable })));

export function TimingsTable(props: { timings: GuideTimings; matchupSlug: string; buildSlug: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const community = <TimingsTableContent timings={props.timings} />;
  if (isLoaded && isSignedIn) return <Suspense fallback={community}><PersonalTimingsTable {...props} /></Suspense>;
  return <div className="space-y-3">{isLoaded ? <GuideSignInPrompt hasTimings /> : null}{community}</div>;
}

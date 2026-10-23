"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/Card";

const Mine = dynamic(() => import("./MyPublishedBuilds").then((module) => module.MyPublishedBuilds), {
  ssr: false,
  loading: () => <div role="status" aria-label="Loading your publications"><Skeleton rows={3} /></div>,
});

/** The public directory does not download the private owner workspace. */
export function LazyMyPublishedBuilds() { return <Mine />; }

"use client";

import { lazy, Suspense } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { guideSignInHref } from "../guideAuthLinks";
import { GUIDE_LINK_CLASS } from "../guideUi";
import type { GuideMapPayload } from "@/lib/guides/types";

const SignedInMap = lazy(() => import("./GuideMapSignedInComparison").then((module) => ({ default: module.GuideMapSignedInComparison })));

/** Private map requests and their code stay behind the signed-in boundary. */
export function GuideMapPersonalComparison({ payload }: { payload: GuideMapPayload }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="min-h-11" aria-hidden />;
  return <section id="your-map" className="scroll-mt-28 space-y-3 rounded-xl border border-border bg-bg-elevated/30 p-4">
    <h2 className="font-display text-h3 font-bold text-text">You on this map</h2>
    {isSignedIn ? <Suspense fallback={<p role="status" className="text-caption text-text-muted">Loading your map record…</p>}><SignedInMap payload={payload} /></Suspense> : <p className="text-caption text-text-muted"><Link href={guideSignInHref(`/guides/maps/${payload.mapSlug}`)} className={GUIDE_LINK_CLASS}>Sign in to compare your map record</Link> with the community.</p>}
  </section>;
}

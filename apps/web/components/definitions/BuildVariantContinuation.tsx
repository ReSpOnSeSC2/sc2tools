"use client";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { signInHref } from "@/lib/authLinks";
import { buildVariantContinuationHref, knownBuildVariantId } from "@/lib/buildVariantIntent";

/** Explicit action after a public auth return; no automatic private navigation. */
export function BuildVariantContinuation({ id, name }: { id: string; name: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const known = knownBuildVariantId(id);
  if (!known) return null;
  return <section aria-label="Continue build variant" className="space-y-2 rounded-xl border border-line bg-bg-surface p-4">
    <p className="font-semibold text-text">Make a private variant of {name}</p>
    {!isLoaded ? <p role="status" className="text-caption text-text-muted">Checking sign-in…</p> : <Link className="inline-flex min-h-11 items-center font-semibold text-text underline underline-offset-2"
      href={isSignedIn ? `/builds?create=detected&definition=${known}` : signInHref(buildVariantContinuationHref(known))}>{isSignedIn ? "Continue private variant" : "Sign in to create this variant"}</Link>}
    <p className="text-caption text-text-muted">Choose a matching replay next. Your build is saved only when you select Save in the editor.</p>
  </section>;
}

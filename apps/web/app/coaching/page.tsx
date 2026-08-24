"use client";

// /coaching — the Coaching Locker, served natively from the site.
//
// Quiet by design: the shared app navigation exposes this route only to
// admins and accounts linked as a coach or student. Signed-out visitors are
// sent to sign-in; direct visits from signed-in accounts without a coaching
// role get the Locker's own invite-only screen.
// Role resolution, state, the user directory and per-account agent
// data all come from /v1/coaching/* with the caller's Clerk JWT.

import { RedirectToSignIn, useAuth } from "@clerk/nextjs";
import { Suspense } from "react";
import CoachingWorkspace from "./CoachingWorkspace";

export default function CoachingPage() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  if (!isSignedIn) return <RedirectToSignIn />;
  return (
    <Suspense fallback={null}>
      <CoachingWorkspace />
    </Suspense>
  );
}

"use client";

import type { ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { isTokenAuthRoute } from "@/lib/tokenAuthRoutes";

/**
 * Hands its render function whether the viewer is signed in: true,
 * false, or null while Clerk is still loading.
 *
 * The 404 and error pages can render anywhere, including the OBS
 * overlay and dock routes, which run without a ClerkProvider (see
 * AppShell). There the viewer is treated as signed out and Clerk is
 * never touched.
 *
 * Example:
 *   <ViewerAuth>{(signedIn) => (signedIn ? <DashboardLink /> : <HomeLink />)}</ViewerAuth>
 */
export function ViewerAuth({ children }: { children: (signedIn: boolean | null) => ReactNode }) {
  const pathname = usePathname();
  if (isTokenAuthRoute(pathname)) return <>{children(false)}</>;
  return <ClerkViewerAuth>{children}</ClerkViewerAuth>;
}

function ClerkViewerAuth({ children }: { children: (signedIn: boolean | null) => ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  return <>{children(isLoaded ? Boolean(isSignedIn) : null)}</>;
}

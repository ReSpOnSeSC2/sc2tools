/**
 * Browser-source surfaces authenticate with the unguessable token in their
 * URL. They deliberately do not need a client-side Clerk provider: OBS browser
 * sources and custom docks have no interactive Clerk session, and a ClerkJS
 * outage must not take a live broadcast surface down with it.
 */
const TOKEN_AUTH_ROUTE_ROOTS = ["/overlay", "/dock"] as const;

/** Match complete path segments only (`/overlay-tools` is a normal page). */
export function isTokenAuthRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return TOKEN_AUTH_ROUTE_ROOTS.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}

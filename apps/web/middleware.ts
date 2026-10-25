import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import { lowercaseGuidePath } from "./lib/guides/canonicalPath";
import { isSharedReplayDetailPath } from "./lib/replayRouteAccess";
import { isPublicStatusRequest, statusHostRedirect } from "./lib/publicStatusRoute";

const PERMANENT_REDIRECT = 308;

/**
 * A mixed-case guide URL ("/guides/PvZ/Stargate-into-Glaives") → 308 to
 * its lowercase form, query kept. Done here, ahead of the ISR cache, so
 * the redirect is one hop with a single Location header.
 */
function guideCaseRedirect(req: NextRequest): NextResponse | null {
  const lowercase = lowercaseGuidePath(req.nextUrl.pathname);
  if (!lowercase) return null;
  const url = req.nextUrl.clone();
  url.pathname = lowercase;
  return NextResponse.redirect(url, PERMANENT_REDIRECT);
}

const isProtected = createRouteMatcher([
  "/app(.*)",
  "/devices(.*)",
  "/streaming(.*)",
  "/builds/new(.*)",
  "/builds/(.*)/edit",
  // The onboarding wizard mints real pairing codes (POST
  // /v1/device-pairings/start with a Clerk token), so it requires a
  // signed-in user — sign-up redirects here.
  "/welcome(.*)",
  // Both render per-user data; the APIs behind them already enforce
  // auth (and /admin enforces isAdmin server-side), but without the
  // matcher a signed-out visitor gets a broken shell instead of the
  // sign-in redirect.
  "/settings(.*)",
  "/notifications(.*)",
  "/admin(.*)",
]);

const authenticatedMiddleware = clerkMiddleware(async (auth, req) => {
  const guideRedirect = guideCaseRedirect(req);
  if (guideRedirect) return guideRedirect;
  if (isProtected(req) || isSharedReplayDetailPath(req.nextUrl.pathname)) {
    await auth.protect();
  }
});

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const statusRedirect = statusHostRedirect(req.url);
  if (statusRedirect) return NextResponse.redirect(statusRedirect, PERMANENT_REDIRECT);
  // Only the status page and the no-database website ping bypass Clerk.
  // Existing private surfaces and replay-detail guards still use the wrapper.
  if (isPublicStatusRequest(req.nextUrl.pathname)) return NextResponse.next();
  return authenticatedMiddleware(req, event);
}

export const config = {
  matcher: [
    "/((?!_next|.*\\..*).*)",
    "/(api|trpc)(.*)",
    // The general matcher skips dotted paths as static assets. Replay ids may
    // contain dots, so explicitly run middleware for both replay URL families;
    // isSharedReplayDetailPath still leaves their public list/assets alone.
    "/players/(.*)",
    "/p/(.*)",
  ],
};

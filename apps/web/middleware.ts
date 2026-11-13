import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import { lowercaseGuidePath } from "./lib/guides/canonicalPath";
import { isReportCardPath, isReportCardPreviewPath } from "./lib/instant/reportCardRoute";
import { isRoomObsPath } from "./lib/matchRoomRoute";
import { isPublicReplayReference, legacyReplayArchivePath } from "./lib/replayRouteAccess";
import { isPublicStatusRequest, statusHostRedirect } from "./lib/publicStatusRoute";

const PERMANENT_REDIRECT = 308;
const SESSIONLESS_PAGES = new Set(["/wrapped", "/wrapped/opengraph-image", "/career", "/arcade/scout"]);

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
  // The private practice log reads only the signed-in owner's grades.
  "/practice(.*)",
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
  const pathname = req.nextUrl.pathname;
  const legacyArchive = legacyReplayArchivePath(pathname);
  const legacyCompare = (pathname === "/app/compare" || pathname === "/app/compare/") && ["a", "b"].some(key =>
    req.nextUrl.searchParams.getAll(key).some(value => !isPublicReplayReference(value)));
  if ((legacyArchive || legacyCompare) && !(await auth()).userId) {
    // An old raw game ID can contain an opponent name. Never carry it
    // through Clerk's return URL. Already-signed-in legacy links resolve
    // to their replacement reference in the replay page.
    const signIn = req.nextUrl.clone();
    signIn.pathname = "/sign-in";
    signIn.search = "";
    signIn.searchParams.set("redirect_url", legacyArchive ?? "/app/compare");
    return NextResponse.redirect(signIn);
  }
  if (isProtected(req)) await auth.protect();
});

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const statusRedirect = statusHostRedirect(req.url);
  if (statusRedirect) return NextResponse.redirect(statusRedirect, PERMANENT_REDIRECT);
  const pathname = req.nextUrl.pathname;
  // Static replay views and the Match Room source work without a Clerk handshake.
  if (isPublicStatusRequest(pathname) || SESSIONLESS_PAGES.has(pathname) || isRoomObsPath(pathname)
    || isReportCardPath(pathname) || isReportCardPreviewPath(pathname)) {
    return NextResponse.next();
  }
  return authenticatedMiddleware(req, event);
}

export const config = {
  matcher: [
    "/((?!_next|.*\\..*).*)",
    "/(api|trpc)(.*)",
    // The general matcher skips dotted paths as static assets. Replay ids may
    // contain dots, so explicitly run middleware for both replay URL families;
    // Public archives, opaque preview paths and metadata images stay accessible.
    "/players/(.*)",
    "/p/(.*)",
  ],
};

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { isSharedReplayDetailPath } from "./lib/replayRouteAccess";

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
  "/admin(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req) || isSharedReplayDetailPath(req.nextUrl.pathname)) {
    await auth.protect();
  }
});

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

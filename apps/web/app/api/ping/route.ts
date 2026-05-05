import { NextResponse } from "next/server";

// Render's "starter" web service idles after a stretch of no inbound traffic
// — when that happens the next visitor eats a 30+ second cold start. This
// route is the cheapest possible heartbeat endpoint to keep the Node process
// warm. It returns a tiny JSON body, never touches the DB, and disables every
// caching layer so each ping actually reaches the origin.
//
// External monitors (UptimeRobot, cron-job.org, BetterStack, etc.) and the
// API's internal keep-alive worker both target this URL.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

export function GET(): NextResponse {
  return NextResponse.json(
    { status: "ok", time: new Date().toISOString() },
    {
      headers: {
        "cache-control": "no-store, max-age=0",
      },
    },
  );
}

export function HEAD(): NextResponse {
  return new NextResponse(null, {
    status: 200,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}

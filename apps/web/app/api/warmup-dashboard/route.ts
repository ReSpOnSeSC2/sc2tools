import { NextResponse } from "next/server";

// Loads the same server-side modules as app/app/page.tsx so a keepalive
// ping primes the V8 module cache that the dashboard SSR will reach for.
// The /app SSR runs inside its own Vercel function — this route is in a
// different function and can't warm that instance directly — but Vercel
// reuses chunks (Next.js core, React, Clerk SDK) across the warm pool,
// and the API client below opens the upstream connection state that
// /v1/me will reuse a few seconds later when a signed-in user lands.
//
// Unauthenticated: Clerk middleware only protects /app, /devices, etc.,
// so the external cron in .github/workflows/api-keepalive.yml can hit
// this route directly without a session token.
import "@/lib/api";

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

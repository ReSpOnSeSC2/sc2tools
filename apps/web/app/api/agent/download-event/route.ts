/**
 * POST /api/agent/download-event
 *
 * Same-origin sink for the website's "download started" beacon. The
 * browser beacon used to POST cross-origin straight to the backend
 * (`API_BASE/v1/agent/download-event`), but `navigator.sendBeacon`
 * with a JSON body is not a CORS-safelisted request, so cross-origin
 * (web origin -> api subdomain) beacons were silently dropped — which
 * is why "Agent downloads" could read 0 even after real clicks.
 *
 * Routing the beacon to this SAME-ORIGIN route sidesteps CORS entirely,
 * then we forward the event to the backend server-side (server-to-
 * server, reliable, no preflight). This is the server-side recording
 * path; it's the single source of truth for download counts, so the
 * client no longer also posts to the backend directly (no double
 * counting). The actual installer link still points straight at the
 * GitHub asset, so the download itself can never depend on this route.
 *
 * Fire-and-forget: always returns 204 so a tracking failure never
 * surfaces to the user mid-download.
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  // sendBeacon may deliver either application/json or a text/plain
  // Blob depending on the browser; accept both.
  try {
    body = await req.json();
  } catch {
    try {
      body = JSON.parse(await req.text());
    } catch {
      body = {};
    }
  }

  const payload = {
    platform: typeof body.platform === "string" ? body.platform : "",
    version: typeof body.version === "string" ? body.version : "",
    channel: typeof body.channel === "string" ? body.channel : "stable",
  };

  // Forward the original client IP / UA / referer so the backend's
  // beacon record reflects the real visitor, not this server.
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const ua = req.headers.get("user-agent");
  const referer = req.headers.get("referer");
  const xff = req.headers.get("x-forwarded-for");
  if (ua) headers["user-agent"] = ua;
  if (referer) headers["referer"] = referer;
  if (xff) headers["x-forwarded-for"] = xff;

  try {
    await fetch(`${API_BASE}/v1/agent/download-event`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    /* swallow — never block the user's download on analytics */
  }

  return new NextResponse(null, { status: 204 });
}

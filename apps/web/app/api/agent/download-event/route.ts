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
 * server, reliable, no preflight). Current download links no longer use
 * a beacon: /api/download/agent records and redirects in one request.
 * This endpoint remains for already-open pages running an older bundle.
 *
 * Compatibility endpoint: always returns 204 so stale browser bundles
 * cannot surface a tracking failure during a download. Forward failures
 * are now logged by the shared server helper.
 */

import { NextRequest, NextResponse } from "next/server";
import { forwardAgentDownloadEvent } from "@/lib/agentDownloadEvents.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  // Legacy browser bundles may still send this beacon after a deployment.
  // Read the stream once so malformed JSON cannot leave it locked before a
  // text fallback. New download links use /api/download/agent directly.
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }

  const payload = {
    platform: typeof body.platform === "string" ? body.platform : "",
    version: typeof body.version === "string" ? body.version : "",
    channel: typeof body.channel === "string" ? body.channel : "stable",
  };

  await forwardAgentDownloadEvent(req, payload);

  return new NextResponse(null, { status: 204 });
}

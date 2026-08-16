/**
 * POST /api/download/agent
 *
 * Tracked installer hand-off. The download card already resolved the latest
 * release metadata (version, SHA, size, and GitHub asset), so it submits that
 * asset here. We validate that it belongs to this repository's agent release,
 * schedule the admin event, then issue a 303 to the installer.
 *
 * POST keeps crawlers and speculative link prefetches from creating events.
 * The event runs through Next's after() lifecycle, so a slow analytics API
 * never delays or prevents the actual installer response.
 */

import { after, NextRequest, NextResponse } from "next/server";
import { forwardAgentDownloadEvent } from "@/lib/agentDownloadEvents.server";

export const runtime = "nodejs";
// Every POST represents a real installer hand-off; never cache the response.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_download_request" },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  const rawAssetUrl = form.get("artifactUrl");
  const asset = trustedAgentAsset(
    typeof rawAssetUrl === "string" ? rawAssetUrl : "",
  );
  if (!asset) {
    return NextResponse.json(
      { ok: false, error: "invalid_agent_artifact" },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  const rawPlatform = form.get("platform");
  const platform = typeof rawPlatform === "string" ? rawPlatform : "windows";
  // Snapshot request headers before the response closes. after() extends the
  // serverless request lifetime for the event write without delaying the 303.
  const eventRequest = { headers: new Headers(req.headers) };
  after(() =>
    forwardAgentDownloadEvent(eventRequest, {
      platform,
      version: asset.version,
      channel: "stable",
    }),
  );

  return NextResponse.redirect(asset.downloadUrl, {
    status: 303,
    headers: noStoreHeaders(),
  });
}

const AGENT_RELEASE_PATH =
  /^\/ReSpOnSeSC2\/sc2tools\/releases\/download\/agent-v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\/([^/]+)$/i;
const AGENT_INSTALLER_NAMES = [
  /^SC2ToolsAgent-Setup-.*\.exe$/i,
  /^sc2tools-agent.*\.exe$/i,
];

function trustedAgentAsset(
  raw: string,
): { downloadUrl: string; version: string } | null {
  try {
    const url = new URL(raw);
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    const match = url.pathname.match(AGENT_RELEASE_PATH);
    if (!match) return null;
    const filename = decodeURIComponent(match[2]);
    if (!AGENT_INSTALLER_NAMES.some((pattern) => pattern.test(filename))) {
      return null;
    }
    return { downloadUrl: url.toString(), version: match[1] };
  } catch {
    return null;
  }
}

function noStoreHeaders(): Record<string, string> {
  return { "Cache-Control": "private, no-store, max-age=0" };
}

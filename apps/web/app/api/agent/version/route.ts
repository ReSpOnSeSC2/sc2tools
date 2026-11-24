/**
 * GET /api/agent/version
 *
 * Public, unauthenticated metadata feed for the SC2 Tools AGENT
 * installer. Resolves the newest published GitHub release matching
 * `agent-v*.*.*` (the lightweight PySide6 agent that connects to
 * sc2tools.app) and reshapes the response into the AgentVersionResp
 * contract the download page consumes.
 *
 * The lookup lives in lib/agentReleaseSource.server.ts, shared with the
 * changelog page and the Agent RSS feed, so all three name the same
 * release. It deliberately ignores `v*` releases: those are the legacy
 * SC2 Tools merged toolkit (bundled Python + Node, runs at
 * localhost:3000), which is for the maintainer's local use only and
 * must NOT be linked from the public website.
 *
 * Caching: edge-cached for 10 min via the s-maxage header. The
 * GitHub API answer is kept in Next's data cache for the same 10 min,
 * so we never hammer it more than 6 times an hour.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  AGENT_INSTALLER_PATTERNS,
  agentVersionFromTag,
  compareAgentVersions,
  fetchLatestAgentRelease,
  type AgentReleaseAsset,
} from "@/lib/agentReleaseSource.server";

export const runtime = "nodejs";
export const revalidate = 600;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const platformParam = url.searchParams.get("platform") || "windows";
  const channelParam = url.searchParams.get("channel") || "stable";
  const current = url.searchParams.get("current") || "0.0.0";

  try {
    const release = await fetchLatestAgentRelease();
    if (!release) {
      return NextResponse.json(
        emptyResp(channelParam, platformParam, current),
        { status: 200, headers: cacheHeaders() },
      );
    }

    const version = agentVersionFromTag(release.tag_name);
    const platformAsset = pickAssetForPlatform(release.assets, platformParam);
    if (!platformAsset) {
      return NextResponse.json(
        {
          ok: true,
          channel: channelParam,
          platform: platformParam,
          update_available: compareAgentVersions(version, current) > 0,
          current,
          latest: version,
          publishedAt: release.published_at,
          releaseNotes: release.body || "",
          minSupportedVersion: null,
        },
        { status: 200, headers: cacheHeaders() },
      );
    }

    const sha256 = await fetchSha256(release.assets, platformAsset.name);

    return NextResponse.json(
      {
        ok: true,
        channel: channelParam,
        platform: platformParam,
        update_available: compareAgentVersions(version, current) > 0,
        current,
        latest: version,
        publishedAt: release.published_at,
        releaseNotes: release.body || "",
        minSupportedVersion: null,
        artifact: {
          platform: platformParam,
          downloadUrl: platformAsset.browser_download_url,
          sha256: sha256 || "",
          sizeBytes: platformAsset.size,
          signature: null,
        },
      },
      { status: 200, headers: cacheHeaders() },
    );
  } catch (err) {
    console.error("[/api/agent/version] github fetch failed", err);
    return NextResponse.json(
      emptyResp(channelParam, platformParam, current),
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function emptyResp(channel: string, platform: string, current: string) {
  return {
    ok: true,
    channel,
    platform,
    update_available: false,
    current,
    latest: undefined,
    publishedAt: undefined,
    releaseNotes: "",
    minSupportedVersion: null,
  };
}

function cacheHeaders() {
  return {
    "Cache-Control": "public, s-maxage=600, stale-while-revalidate=86400",
  };
}

function pickAssetForPlatform(
  assets: AgentReleaseAsset[],
  platform: string,
): AgentReleaseAsset | null {
  if (platform !== "windows") return null;
  for (const rx of AGENT_INSTALLER_PATTERNS) {
    const hit = assets.find((a) => rx.test(a.name));
    if (hit) return hit;
  }
  return null;
}

async function fetchSha256(
  assets: AgentReleaseAsset[],
  exeName: string,
): Promise<string | null> {
  const sidecar = assets.find((a) => a.name === `${exeName}.sha256`);
  if (!sidecar) return null;
  try {
    const res = await fetch(sidecar.browser_download_url, {
      next: { revalidate: 600 },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const match = text.trim().match(/^([0-9a-f]{64})/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

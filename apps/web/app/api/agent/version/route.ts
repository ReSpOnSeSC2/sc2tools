/**
 * GET /api/agent/version
 *
 * Public, unauthenticated metadata feed for the SC2 Tools Agent
 * installer. Resolves the latest GitHub release matching `agent-v*.*.*`
 * and reshapes the response into the AgentVersionResp contract the
 * download page (and, in time, the agent's auto-updater) consume.
 *
 * Why a Next.js route and not the Express API: the download page
 * needs to work for logged-out visitors too, and the existing
 * `/v1/agent/version` is gated through `useApi` (which requires Clerk
 * auth) and reads from a Mongo collection nobody has populated yet.
 * This route hits the GitHub API directly and is shaped identically,
 * so the existing components light up the moment the workflow tags
 * its first release.
 *
 * Caching strategy:
 *   * `revalidate = 600` (10 min) — fresh enough for a release page,
 *     gentle enough to never trip GitHub's 60-req/hr unauthenticated
 *     rate limit.
 *   * `Cache-Control: public, s-maxage=600` so the CDN edge can serve
 *     repeat hits without us hitting GitHub at all.
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 600;

const GITHUB_OWNER = "ReSpOnSeSC2";
const GITHUB_REPO = "sc2tools";
const RELEASE_TAG_PREFIX = "agent-v";

type Asset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type GitHubRelease = {
  tag_name: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  assets: Asset[];
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const platformParam = url.searchParams.get("platform") || "windows";
  const channelParam = url.searchParams.get("channel") || "stable";
  const current = url.searchParams.get("current") || "0.0.0";

  try {
    const release = await fetchLatestAgentRelease();
    if (!release) {
      return NextResponse.json(emptyResp(channelParam, platformParam, current), {
        status: 200,
        headers: cacheHeaders(),
      });
    }

    const version = release.tag_name.replace(RELEASE_TAG_PREFIX, "");
    const platformAsset = pickAssetForPlatform(release.assets, platformParam);
    if (!platformAsset) {
      return NextResponse.json(
        {
          ok: true,
          channel: channelParam,
          platform: platformParam,
          update_available: isNewer(version, current),
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
        update_available: isNewer(version, current),
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
    // Surface a graceful empty response on any failure — the UI
    // already renders a "no installer yet" state for that case.
    console.error("[/api/agent/version] github fetch failed", err);
    return NextResponse.json(emptyResp(channelParam, platformParam, current), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
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

async function fetchLatestAgentRelease(): Promise<GitHubRelease | null> {
  // /releases (not /releases/latest) so we can filter to agent-v* tags
  // — the repo also publishes other tag prefixes (the merged toolkit
  // installer, etc.) and /latest would pick whichever was newest
  // overall.
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`;
  const res = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "sc2tools-website",
      // GITHUB_TOKEN bumps the rate limit from 60/hr to 5000/hr when set.
      ...(process.env.GITHUB_TOKEN
        ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
    next: { revalidate: 600 },
  });
  if (!res.ok) {
    throw new Error(`github releases fetch ${res.status}`);
  }
  const releases = (await res.json()) as GitHubRelease[];
  return (
    releases.find(
      (r) =>
        r.tag_name?.startsWith(RELEASE_TAG_PREFIX) &&
        !r.draft &&
        !r.prerelease,
    ) || null
  );
}

function pickAssetForPlatform(
  assets: Asset[],
  platform: string,
): Asset | null {
  if (platform === "windows") {
    return (
      assets.find(
        (a) =>
          /SC2ToolsAgent-Setup.*\.exe$/i.test(a.name) ||
          /sc2tools-agent.*\.exe$/i.test(a.name),
      ) || null
    );
  }
  // No first-class macOS/Linux installers yet — the page falls back to
  // the "Run from source" panel for those.
  return null;
}

async function fetchSha256(
  assets: Asset[],
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
    // Format produced by our workflow: "<hash> *<filename>"
    const match = text.trim().match(/^([0-9a-f]{64})/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function parseSemver(v: string): [number, number, number] {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * GET /api/agent/version
 *
 * Public, unauthenticated metadata feed for the SC2 Tools installer.
 * Resolves the latest GitHub release matching `v*.*.*` (the existing
 * release.yml workflow tags this way) and reshapes the response into
 * the AgentVersionResp contract the download page consumes.
 *
 * Why a Next.js route and not the Express API: the download page
 * needs to work for logged-out visitors too, and the existing
 * `/v1/agent/version` is gated through `useApi` (which requires Clerk
 * auth) and reads from a Mongo collection nobody has populated yet.
 * This route hits the GitHub API directly and is shaped identically,
 * so the existing components light up immediately.
 *
 * Caching: edge-cached for 10 min via the s-maxage header. The
 * GitHub API also gets a `next: { revalidate: 600 }` so we never
 * hammer it more than 6 times an hour.
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 600;

const GITHUB_OWNER = "ReSpOnSeSC2";
const GITHUB_REPO = "sc2tools";

// The existing workflow (release.yml) ships installers with this tag
// pattern and asset filename. We accept either the merged-toolkit
// installer (SC2Tools-Setup-*.exe) or the future agent-only installer
// (SC2ToolsAgent-Setup-*.exe) so both build pipelines can feed the
// download page without further wiring.
const TAG_REGEX = /^v\d+\.\d+\.\d+(?:[-+].*)?$/;
const EXE_REGEXES: RegExp[] = [
  /^SC2Tools-Setup-.*\.exe$/i,
  /^SC2ToolsAgent-Setup-.*\.exe$/i,
  /^sc2tools-agent.*\.exe$/i,
];

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
    const release = await fetchLatestRelease();
    if (!release) {
      return NextResponse.json(
        emptyResp(channelParam, platformParam, current),
        { status: 200, headers: cacheHeaders() },
      );
    }

    const version = release.tag_name.replace(/^v/, "");
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

async function fetchLatestRelease(): Promise<GitHubRelease | null> {
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`;
  const res = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "sc2tools-website",
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
        TAG_REGEX.test(r.tag_name || "") &&
        !r.draft &&
        !r.prerelease &&
        Array.isArray(r.assets) &&
        r.assets.some((a) => EXE_REGEXES.some((rx) => rx.test(a.name))),
    ) || null
  );
}

function pickAssetForPlatform(
  assets: Asset[],
  platform: string,
): Asset | null {
  if (platform !== "windows") return null;
  for (const rx of EXE_REGEXES) {
    const hit = assets.find((a) => rx.test(a.name));
    if (hit) return hit;
  }
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

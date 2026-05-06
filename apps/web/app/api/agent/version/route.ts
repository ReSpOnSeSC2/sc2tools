/**
 * GET /api/agent/version
 *
 * Public, unauthenticated metadata feed for the SC2 Tools AGENT
 * installer. Resolves the latest GitHub release matching `agent-v*.*.*`
 * (the new lightweight PySide6 agent that connects to sc2tools.app)
 * and reshapes the response into the AgentVersionResp contract the
 * download page consumes.
 *
 * Important: this route deliberately ignores `v*` releases — those are
 * the legacy SC2 Tools merged toolkit (bundled Python + Node, runs at
 * localhost:3000) which is for the maintainer's local use only and
 * must NOT be linked from the public website.
 *
 * Caching: edge-cached for 10 min via the s-maxage header. The
 * GitHub API also gets `next: { revalidate: 600 }` so we never
 * hammer it more than 6 times an hour.
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 600;

const GITHUB_OWNER = "ReSpOnSeSC2";
const GITHUB_REPO = "sc2tools";

// Only the new lightweight agent. The legacy SC2Tools-Setup-*.exe
// installers are deliberately NOT matched here — they are private
// dev artifacts that should never be offered to public visitors.
const TAG_REGEX = /^agent-v\d+\.\d+\.\d+(?:[-+].*)?$/;
const EXE_REGEXES: RegExp[] = [
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

    const version = release.tag_name.replace(/^agent-v/, "");
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
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=30`;
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
  // GitHub's `/releases` endpoint orders results lexicographically by
  // tag, NOT by semver — so `agent-v0.3.11` lands AFTER `agent-v0.3.4`
  // ("11" < "4" as a string). Picking `releases.find(...)` would
  // therefore freeze the download page on `v0.3.4` even after `v0.3.11`
  // ships. Filter to eligible releases first, then sort by semver
  // descending so the actual newest version always wins.
  const eligible = releases.filter(
    (r) =>
      TAG_REGEX.test(r.tag_name || "") &&
      !r.draft &&
      !r.prerelease &&
      Array.isArray(r.assets) &&
      r.assets.some((a) => EXE_REGEXES.some((rx) => rx.test(a.name))),
  );
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => compareSemverTagDesc(a.tag_name, b.tag_name));
  return eligible[0];
}

/**
 * Sort comparator: descending by the semver embedded in an
 * `agent-vX.Y.Z` tag name. Tags that don't parse fall to the end so
 * a malformed tag never starves a real release.
 */
function compareSemverTagDesc(a: string, b: string): number {
  const va = parseSemver(a.replace(/^agent-v/, ""));
  const vb = parseSemver(b.replace(/^agent-v/, ""));
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return vb[i] - va[i];
  }
  return 0;
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

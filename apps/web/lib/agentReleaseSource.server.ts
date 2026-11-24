/**
 * The newest published SC2 Tools Agent release, read from GitHub.
 *
 * One source for the download metadata route (`/api/agent/version`), the
 * changelog page's Agent release notes and the Agent RSS feed, so all three
 * name the same version and share one cached GitHub request: Next's data
 * cache keeps each answer for 10 minutes. A release counts once it is
 * published (not a draft or prerelease), is tagged `agent-vX.Y.Z` and has the
 * Windows installer attached. Legacy `v*` releases are the maintainer's
 * private toolkit builds and never count.
 */

import { PHASE_PRODUCTION_BUILD } from "next/constants";

/**
 * How long one GitHub answer is reused. Pages and feeds rendered from it
 * revalidate on the same period (route segment config must repeat the
 * literal, so a test pins each one to this value).
 */
export const AGENT_RELEASES_REVALIDATE_SECONDS = 600;

const GITHUB_API_ORIGIN = "https://api.github.com";
const RELEASES_URL = `${GITHUB_API_ORIGIN}/repos/ReSpOnSeSC2/sc2tools/releases?per_page=30`;
/** A GitHub that never answers must not hold up a build or a revalidation. */
const REQUEST_TIMEOUT_MS = 10_000;
const TAG_PATTERN = /^agent-v\d+\.\d+\.\d+(?:[-+].*)?$/;

/**
 * Windows installer names the `agent installer` workflow attaches to a
 * release. The legacy toolkit's `SC2Tools-Setup-*.exe` never matches.
 */
export const AGENT_INSTALLER_PATTERNS: readonly RegExp[] = [
  /^SC2ToolsAgent-Setup-.*\.exe$/i,
  /^sc2tools-agent.*\.exe$/i,
];

export type AgentReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

export type GitHubAgentRelease = {
  tag_name: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string;
  assets: AgentReleaseAsset[];
};

/**
 * The releases list to read. End-to-end tests point `AGENT_RELEASES_URL` at
 * their fixture API so they never depend on GitHub; production leaves it
 * unset.
 */
function releasesUrl(): string {
  return process.env.AGENT_RELEASES_URL || RELEASES_URL;
}

function requestHeaders(url: string): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  // The token only ever goes to GitHub's API, never to an overridden URL.
  const toGitHub = new URL(url).origin === GITHUB_API_ORIGIN;
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "sc2tools-website",
    ...(token && toGitHub ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** The agent version an `agent-vX.Y.Z` tag names. */
export function agentVersionFromTag(tag: string): string {
  return tag.replace(/^agent-v/, "");
}

/** Orders agent versions by MAJOR.MINOR.PATCH. Text that doesn't parse sorts as 0.0.0. */
export function compareAgentVersions(left: string, right: string): number {
  const [leftMajor, leftMinor, leftPatch] = versionParts(left);
  const [rightMajor, rightMinor, rightPatch] = versionParts(right);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}

function versionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

function isPublishedAgentRelease(value: unknown): value is GitHubAgentRelease {
  if (typeof value !== "object" || value === null) return false;
  const release = value as Partial<GitHubAgentRelease>;
  return typeof release.tag_name === "string"
    && TAG_PATTERN.test(release.tag_name)
    && !release.draft
    && !release.prerelease
    && Array.isArray(release.assets)
    && release.assets.some(asset => AGENT_INSTALLER_PATTERNS.some(pattern => pattern.test(asset?.name ?? "")));
}

async function readReleaseList(): Promise<unknown> {
  const url = releasesUrl();
  const response = await fetch(url, {
    headers: requestHeaders(url),
    next: { revalidate: AGENT_RELEASES_REVALIDATE_SECONDS },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`github releases fetch ${response.status}`);
  return response.json();
}

/**
 * Rejects once `ms` have passed. Next drops a fetch's `signal` when it
 * refreshes a stale data-cache entry, which every regeneration (and every
 * Vercel build) does, so the deadline can't rely on the signal alone.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`github releases fetch timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The newest published agent release, or null when GitHub lists none.
 * Throws when GitHub can't be read: a network failure, the 10-second
 * deadline, an error status, or a body that isn't a list of releases.
 *
 * GitHub doesn't list releases in version order, so the published ones are
 * sorted by version: `agent-v0.3.11` is newer than `agent-v0.3.4`.
 */
export async function fetchLatestAgentRelease(): Promise<GitHubAgentRelease | null> {
  const releases = await withDeadline(readReleaseList(), REQUEST_TIMEOUT_MS);
  if (!Array.isArray(releases)) throw new Error("github releases response is not a list");
  const published = releases.filter(isPublishedAgentRelease);
  published.sort((left, right) => compareAgentVersions(agentVersionFromTag(right.tag_name), agentVersionFromTag(left.tag_name)));
  return published[0] ?? null;
}

/** The name instrumentation.ts uses to leave this expected failure out of error reports. */
export const AGENT_RELEASES_UNAVAILABLE = "AgentReleasesUnavailableError";

/**
 * Thrown on a production server when GitHub's release list can't be read,
 * so Next keeps serving the page it last rendered from a good answer. It is
 * expected and handled, so it isn't reported to Sentry; Next still logs it.
 */
export class AgentReleasesUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`GitHub's agent release list can't be read (${describe(cause)}); keeping the last rendered page`, { cause });
    this.name = AGENT_RELEASES_UNAVAILABLE;
  }
}

/**
 * The newest published agent version, or null when there is no answer to
 * go by: GitHub lists no published release, or it can't be read while
 * building or in development, where the caller falls back to the build's
 * own version. A production server throws AgentReleasesUnavailableError
 * instead, so Next keeps serving the page it last rendered from a good
 * answer and tries again on a later request.
 */
export async function latestPublishedAgentVersion(): Promise<string | null> {
  try {
    const release = await fetchLatestAgentRelease();
    return release ? agentVersionFromTag(release.tag_name) : null;
  } catch (error) {
    if (isProductionServer()) throw new AgentReleasesUnavailableError(error);
    console.warn(`[agent releases] GitHub's release list can't be read (${describe(error)}); using the build's fallback version`);
    return null;
  }
}

function isProductionServer(): boolean {
  return process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD;
}

/** One line for logs: the error's message and, for a network failure, its code. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${error.message}: ${code}` : error.message;
}

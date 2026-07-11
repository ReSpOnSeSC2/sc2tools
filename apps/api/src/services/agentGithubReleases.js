"use strict";

/**
 * GithubReleaseFeed — GitHub-releases source for the agent
 * auto-update feed.
 *
 * Why this exists
 * ---------------
 * Cutting an agent release is a tag push: `agent-v*` triggers the
 * installer workflow, which attaches `SC2ToolsAgent-Setup-<v>.exe` +
 * its `.sha256` sidecar to the GitHub Release. The website's download
 * card (apps/web/app/api/agent/version/route.ts) resolves the newest
 * such release straight from the GitHub API, so to a maintainer the
 * tag push *looks* like the whole publish. But the installed agent's
 * updater polls THIS API's `GET /v1/agent/version`, whose feed only
 * served rows manually POSTed to `/v1/agent/releases` — so installed
 * agents silently stayed on the old build whenever that curl step was
 * forgotten (which is how the 0.13.3 building-death fix sat unshipped
 * while the site already offered its installer).
 *
 * This class ports the website's GitHub resolution server-side so
 * `AgentVersionService.latest()` can merge both sources and offer
 * whichever is newer. Mongo rows still win ties, so a manually
 * published release can carry curated notes / minSupportedVersion.
 *
 * Shape parity: `latest()` returns the same object
 * `AgentVersionService.latest()` builds from a Mongo row, with
 * `source: "github"` added for observability.
 *
 * Caching: one in-memory entry with a TTL (default 10 min, matching
 * the website route's `s-maxage`). On a fetch failure the stale value
 * keeps being served so a GitHub outage never blanks the feed; when
 * there is no cached value yet, failures resolve to `null` and the
 * caller falls back to Mongo alone.
 */

/**
 * The merged release descriptor the version route serves. Shared with
 * ``agentVersion.js`` (the DB side produces the same shape minus
 * ``source``).
 *
 * @typedef {{
 *   channel: string,
 *   version: string,
 *   publishedAt: string | null,
 *   releaseNotes: string,
 *   minSupportedVersion: string | null,
 *   source?: string,
 *   artifact: {
 *     platform: string,
 *     downloadUrl: string,
 *     sha256: string,
 *     sizeBytes: number | null,
 *     signature: string | null,
 *   },
 * }} AgentReleaseInfo
 */

const SEMVER_TAG_RE = /^agent-v(\d+)\.(\d+)\.(\d+)$/;
const EXE_RE = /^SC2ToolsAgent-Setup-.*\.exe$/i;
const SHA256_RE = /^([0-9a-f]{64})/i;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

class GithubReleaseFeed {
  /**
   * @param {{
   *   owner: string,
   *   repo: string,
   *   token?: string | null,
   *   ttlMs?: number,
   *   fetchImpl?: typeof fetch,
   *   logger?: { warn: (o: object, m: string) => void } | null,
   * }} opts
   */
  constructor(opts) {
    if (!opts || !opts.owner || !opts.repo) {
      throw new Error("GithubReleaseFeed: owner and repo required");
    }
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.token = opts.token || null;
    this.ttlMs = typeof opts.ttlMs === "number" ? opts.ttlMs : DEFAULT_TTL_MS;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.logger = opts.logger || null;
    /** @type {{at: number, value: AgentReleaseInfo | null} | null} */
    this._cache = null;
  }

  /**
   * Newest eligible GitHub release for `platform`, or null. Only the
   * stable channel and the windows platform exist on GitHub (the
   * installer workflow builds one .exe per tag); anything else
   * resolves to null and the caller serves Mongo alone.
   *
   * @param {{ channel?: string, platform?: string }} [opts]
   * @returns {Promise<AgentReleaseInfo | null>}
   */
  async latest(opts = {}) {
    const channel = String(opts.channel || "stable");
    const platform = String(opts.platform || "windows");
    if (channel !== "stable" || platform !== "windows") return null;
    const now = Date.now();
    if (this._cache && now - this._cache.at < this.ttlMs) {
      return this._cache.value;
    }
    try {
      const value = await this._resolve();
      this._cache = { at: now, value };
      return value;
    } catch (err) {
      if (this.logger) {
        this.logger.warn(
          { err: String(err && /** @type {any} */ (err).message) },
          "agent_github_release_fetch_failed",
        );
      }
      // Serve stale on error; refresh the timestamp so a hard GitHub
      // outage retries once per TTL instead of on every poll.
      if (this._cache) {
        this._cache = { at: now, value: this._cache.value };
        return this._cache.value;
      }
      return null;
    }
  }

  /** @returns {Promise<AgentReleaseInfo | null>} */
  async _resolve() {
    const releases = await this._fetchJson(
      `https://api.github.com/repos/${this.owner}/${this.repo}/releases?per_page=30`,
    );
    if (!Array.isArray(releases)) return null;
    const eligible = releases
      .map(
        /** @param {any} r */ (r) => ({
          release: r,
          semver: parseTag(r && r.tag_name),
        }),
      )
      .filter(
        ({ release, semver }) =>
          semver !== null &&
          !release.draft &&
          !release.prerelease &&
          Array.isArray(release.assets) &&
          release.assets.some(/** @param {any} a */ (a) => EXE_RE.test(a && a.name)),
      )
      // The filter above guarantees ``semver`` is non-null on every
      // survivor; TS can't carry that narrowing onto the destructured
      // object property.
      .sort((a, b) =>
        compareSemverDesc(
          /** @type {[number, number, number]} */ (a.semver),
          /** @type {[number, number, number]} */ (b.semver),
        ),
      );
    if (eligible.length === 0) return null;
    const { release } = eligible[0];
    const exe = release.assets.find(/** @param {any} a */ (a) => EXE_RE.test(a && a.name));
    const sha256 = await this._fetchSha256(release.assets, exe.name);
    // The agent's updater hard-verifies sha256 before launching the
    // installer, so a release whose sidecar is missing or malformed
    // must not be offered — better to keep agents on the old build
    // than to offer an update every poll that always fails to verify.
    if (!sha256) return null;
    return {
      channel: "stable",
      version: release.tag_name.replace(/^agent-v/, ""),
      publishedAt: release.published_at || null,
      releaseNotes: String(release.body || "").slice(0, 16384),
      minSupportedVersion: null,
      source: "github",
      artifact: {
        platform: "windows",
        downloadUrl: exe.browser_download_url,
        sha256,
        sizeBytes: typeof exe.size === "number" ? exe.size : null,
        signature: null,
      },
    };
  }

  /**
   * @param {Array<{name?: string, browser_download_url?: string}>} assets
   * @param {string} exeName
   * @returns {Promise<string | null>}
   */
  async _fetchSha256(assets, exeName) {
    const sidecar = assets.find((a) => a && a.name === `${exeName}.sha256`);
    if (!sidecar || !sidecar.browser_download_url) return null;
    const text = await this._fetchText(sidecar.browser_download_url);
    const match = String(text || "").trim().match(SHA256_RE);
    return match ? match[1].toLowerCase() : null;
  }

  /** @param {string} url */
  async _fetchJson(url) {
    const res = await this._request(url, "application/vnd.github+json");
    return res.json();
  }

  /** @param {string} url */
  async _fetchText(url) {
    const res = await this._request(url, "application/octet-stream");
    return res.text();
  }

  /**
   * @param {string} url
   * @param {string} accept
   */
  async _request(url, accept) {
    const res = await this.fetchImpl(url, {
      headers: {
        Accept: accept,
        "User-Agent": "sc2tools-api agent-release-feed",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`github fetch ${res.status} for ${url}`);
    return res;
  }
}

/**
 * @param {unknown} tag
 * @returns {[number, number, number] | null}
 */
function parseTag(tag) {
  const m = SEMVER_TAG_RE.exec(String(tag || ""));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 */
function compareSemverDesc(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return 0;
}

module.exports = { GithubReleaseFeed };

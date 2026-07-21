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
 * the website route's `s-maxage`). Two hazards shape the cache rules,
 * both observed live when 0.15.8 shipped while agents were told
 * 0.15.5 was current:
 *
 *   * A release is published minutes before the installer workflow
 *     finishes attaching its .exe (the build takes ~10-25 min when
 *     the release is created by hand from the tag). Resolving in that
 *     window correctly yields the previous release — but caching it
 *     for the full TTL keeps advertising the old version after the
 *     assets land. When a published `agent-v*` release newer than the
 *     resolved one exists (its installer just isn't verifiable yet),
 *     the result is cached with the short `pendingTtlMs` instead.
 *   * On a fetch failure the stale value keeps being served so a
 *     GitHub blip never blanks the feed — but only up to
 *     `staleMaxMs`. Unauthenticated api.github.com calls from a
 *     shared-IP host are routinely 403 rate-limited, and an uncapped
 *     serve-stale-on-error loop pinned the feed to its last snapshot
 *     indefinitely. Past the cap the cache is dropped and the caller
 *     falls back to Mongo alone. (Set GITHUB_TOKEN on the API deploy
 *     to lift the rate limit from 60 to 5000 req/h; the feed also
 *     sends If-None-Match so unchanged polls are free 304s.)
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
const ASSET_DIGEST_RE = /^sha256:([0-9a-f]{64})$/i;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PENDING_TTL_MS = 2 * 60 * 1000;
const DEFAULT_STALE_MAX_MS = 6 * 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;
// How many eligible releases to walk when the newest one's sha256
// can't be established — bounds sidecar fetches per resolve.
const MAX_SHA_WALK = 3;

class GithubReleaseFeed {
  /**
   * @param {{
   *   owner: string,
   *   repo: string,
   *   token?: string | null,
   *   ttlMs?: number,
   *   pendingTtlMs?: number,
   *   staleMaxMs?: number,
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
    this.pendingTtlMs =
      typeof opts.pendingTtlMs === "number"
        ? opts.pendingTtlMs
        : DEFAULT_PENDING_TTL_MS;
    this.staleMaxMs =
      typeof opts.staleMaxMs === "number" ? opts.staleMaxMs : DEFAULT_STALE_MAX_MS;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.logger = opts.logger || null;
    /**
     * @type {{
     *   at: number,
     *   goodAt: number,
     *   freshForMs: number,
     *   value: AgentReleaseInfo | null,
     * } | null}
     * `at` paces attempts (fresh window / error retries), `goodAt` is
     * the last successful resolve — the stale cap measures from it.
     */
    this._cache = null;
    /** @type {string | null} ETag of the last releases-list response. */
    this._releasesEtag = null;
    /** @type {any[] | null} Parsed body the ETag corresponds to. */
    this._releasesBody = null;
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
    if (this._cache && now - this._cache.at < this._cache.freshForMs) {
      return this._cache.value;
    }
    try {
      const { value, newerPending } = await this._resolve();
      this._cache = {
        at: now,
        goodAt: now,
        freshForMs: newerPending ? this.pendingTtlMs : this.ttlMs,
        value,
      };
      return value;
    } catch (err) {
      if (this.logger) {
        this.logger.warn(
          { err: String(err && /** @type {any} */ (err).message) },
          "agent_github_release_fetch_failed",
        );
      }
      // Serve stale on error — but only within staleMaxMs of the last
      // successful resolve; past that the snapshot is more likely
      // wrong than useful, so drop it and let the caller serve Mongo.
      // Refresh `at` so a hard GitHub outage retries once per TTL
      // instead of on every poll.
      if (this._cache && now - this._cache.goodAt < this.staleMaxMs) {
        this._cache = { ...this._cache, at: now, freshForMs: this.ttlMs };
        return this._cache.value;
      }
      this._cache = null;
      return null;
    }
  }

  /**
   * @returns {Promise<{
   *   value: AgentReleaseInfo | null,
   *   newerPending: boolean,
   * }>} `newerPending` — a published `agent-v*` release newer than
   * `value` exists but can't be offered yet (installer or sidecar not
   * attached / unverifiable — typically the publish→asset-upload
   * window of an in-flight release), so the result should only be
   * cached briefly.
   */
  async _resolve() {
    const releases = await this._fetchReleases();
    if (!Array.isArray(releases)) return { value: null, newerPending: false };
    const published = releases
      .map(
        /** @param {any} r */ (r) => ({
          release: r,
          semver: parseTag(r && r.tag_name),
        }),
      )
      .filter(
        ({ release, semver }) =>
          semver !== null && !release.draft && !release.prerelease,
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
    const eligible = published.filter(
      ({ release }) =>
        Array.isArray(release.assets) &&
        release.assets.some(/** @param {any} a */ (a) => EXE_RE.test(a && a.name)),
    );

    // The agent's updater hard-verifies sha256 before launching the
    // installer, so a release whose hash can't be established must
    // not be offered — every poll would download + fail forever.
    // Walk down to the newest release that IS verifiable (usually the
    // very first: the asset's own `digest` field answers without any
    // extra fetch) rather than blanking the whole feed.
    let value = null;
    let valueSemver = null;
    for (const { release, semver } of eligible.slice(0, MAX_SHA_WALK)) {
      const exe = release.assets.find(
        /** @param {any} a */ (a) => EXE_RE.test(a && a.name),
      );
      const sha256 =
        assetDigestSha256(exe) ||
        (await this._fetchSha256(release.assets, exe.name));
      if (!sha256) continue;
      value = {
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
      valueSemver = semver;
      break;
    }

    const newest = published.length > 0 ? published[0].semver : null;
    const newerPending =
      newest !== null &&
      (valueSemver === null ||
        semverGt(
          /** @type {[number, number, number]} */ (newest),
          /** @type {[number, number, number]} */ (valueSemver),
        ));
    return { value, newerPending };
  }

  /**
   * Releases list with ETag revalidation: a 304 reuses the previous
   * parsed body and — per GitHub's documented behaviour — costs no
   * rate-limit quota, which matters on unauthenticated shared-IP
   * deploys where the 60 req/h budget is contended.
   *
   * @returns {Promise<any>}
   */
  async _fetchReleases() {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/releases?per_page=30`;
    const res = await this.fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "sc2tools-api agent-release-feed",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(this._releasesEtag && this._releasesBody
          ? { "If-None-Match": this._releasesEtag }
          : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 304 && this._releasesBody) return this._releasesBody;
    if (!res.ok) throw new Error(`github fetch ${res.status} for ${url}`);
    const body = await res.json();
    const etag =
      res.headers && typeof res.headers.get === "function"
        ? res.headers.get("etag")
        : null;
    this._releasesEtag = etag || null;
    this._releasesBody = Array.isArray(body) ? body : null;
    return body;
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
 * GitHub attaches a server-computed `digest: "sha256:<hex>"` to
 * release assets — same trust domain as the sidecar file, no extra
 * fetch. Older cached payloads may lack it; callers fall back to the
 * sidecar.
 *
 * @param {any} asset
 * @returns {string | null}
 */
function assetDigestSha256(asset) {
  const m = ASSET_DIGEST_RE.exec(String((asset && asset.digest) || ""));
  return m ? m[1].toLowerCase() : null;
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

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 */
function semverGt(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

module.exports = { GithubReleaseFeed };

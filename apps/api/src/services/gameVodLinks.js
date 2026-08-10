"use strict";

/**
 * Compose direct provider archive matching with SC2Pulse's participant-level
 * Twitch index. Keeping the adapters separate makes each upstream fail-soft:
 * a YouTube page change cannot hide a valid Pulse link, and a Pulse outage
 * cannot hide an archive found from the user's configured channel.
 */
class GameVodLinksService {
  /**
   * @param {{
   *   archives: {resolveForGames(userId: string, games: any[], opts?: object): Promise<any>},
   *   pulseMatches?: {resolveForGames(games: any[]): Promise<any>} | null,
   *   log?: {warn?: Function} | null,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.archives) {
      throw new Error("GameVodLinksService requires archives");
    }
    this.archives = deps.archives;
    this.pulseMatches = deps.pulseMatches || null;
    this.log = deps.log || null;
  }

  /**
   * @param {string} userId
   * @param {Array<Record<string, any>>} games
   * @param {{includeOpponent?: boolean}} [opts]
   */
  async resolveForGames(userId, games, opts = {}) {
    const candidates = Array.isArray(games) ? games : [];
    const archivePromise = this.archives
      .resolveForGames(userId, candidates, opts)
      .catch((err) => {
        this._warn(err, "archives");
        return null;
      });
    const pulsePromise = opts.includeOpponent === true && this.pulseMatches
      ? this.pulseMatches.resolveForGames(candidates).catch((err) => {
          this._warn(err, "sc2pulse");
          return null;
        })
      : Promise.resolve(null);

    const [archiveResult, pulseResult] = await Promise.all([
      archivePromise,
      pulsePromise,
    ]);
    const configuredPlatforms = normalizePlatforms(
      archiveResult?.configuredPlatforms,
    );
    /** @type {Record<string, any[]>} */
    const linksByGameId = Object.create(null);

    for (const game of candidates) {
      const gameId = cleanGameId(game?.gameId);
      if (gameId) linksByGameId[gameId] = [];
    }
    mergeLinks(linksByGameId, archiveResult?.linksByGameId);
    mergeLinks(linksByGameId, pulseResult?.linksByGameId);
    for (const links of Object.values(linksByGameId)) {
      links.sort(compareLinks);
    }
    return { configuredPlatforms, linksByGameId };
  }

  /** @param {unknown} err @param {string} source */
  _warn(err, source) {
    this.log?.warn?.(
      { err: String(err), source },
      "game_vod_source_failed",
    );
  }
}

/**
 * One icon per platform and perspective is intentional: when both direct
 * matching and SC2Pulse know the same Twitch broadcast, the table should not
 * render two indistinguishable Twitch buttons. Direct configured/public
 * channel results are merged first and therefore win the tie.
 *
 * @param {Record<string, any[]>} target
 * @param {unknown} source
 */
function mergeLinks(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const [rawGameId, rawLinks] of Object.entries(source)) {
    const gameId = cleanGameId(rawGameId);
    if (!gameId || !Object.prototype.hasOwnProperty.call(target, gameId)) {
      continue;
    }
    if (!Array.isArray(rawLinks)) continue;
    for (const raw of rawLinks) {
      const link = normalizeLink(raw);
      if (!link) continue;
      const duplicate = target[gameId].some(
        (existing) =>
          existing.platform === link.platform
          && existing.perspective === link.perspective,
      );
      if (!duplicate) target[gameId].push(link);
    }
  }
}

/** @param {unknown} raw @returns {Record<string, any>|null} */
function normalizeLink(raw) {
  if (!raw || typeof raw !== "object") return null;
  const link = /** @type {Record<string, any>} */ (raw);
  if (link.platform !== "twitch" && link.platform !== "youtube") return null;
  if (link.perspective !== "me" && link.perspective !== "opponent") {
    return null;
  }
  if (typeof link.playerName !== "string" || !link.playerName.trim()) {
    return null;
  }
  if (typeof link.url !== "string" || !isProviderUrl(link.platform, link.url)) {
    return null;
  }
  const offsetSec = Number(link.offsetSec);
  if (!Number.isFinite(offsetSec) || offsetSec < 0 || offsetSec > 604_800) {
    return null;
  }
  const playerName = link.playerName
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 80);
  if (!playerName) return null;
  return /** @type {Record<string, any>} */ ({
    ...link,
    playerName,
    offsetSec: Math.floor(offsetSec),
  });
}

/** @param {'twitch'|'youtube'} platform @param {string} raw */
function isProviderUrl(platform, raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (platform === "twitch") {
      return host === "twitch.tv" && /^\/videos\/\d+\/?$/.test(url.pathname);
    }
    return (
      (
        host === "youtube.com"
        && url.pathname === "/watch"
        && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") || "")
      )
      || (host === "youtu.be" && /^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname))
    );
  } catch {
    return false;
  }
}

/** @param {unknown} value */
function normalizePlatforms(value) {
  if (!Array.isArray(value)) return [];
  return ["twitch", "youtube"].filter((platform) => value.includes(platform));
}

/** @param {unknown} value */
function cleanGameId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= 200 ? id : null;
}

/** @param {Record<string, any>} a @param {Record<string, any>} b */
function compareLinks(a, b) {
  const aPerspective = a.perspective === "me" ? 0 : 1;
  const bPerspective = b.perspective === "me" ? 0 : 1;
  const aPlatform = a.platform === "twitch" ? 0 : 1;
  const bPlatform = b.platform === "twitch" ? 0 : 1;
  return (
    aPerspective - bPerspective
    || aPlatform - bPlatform
  );
}

module.exports = { GameVodLinksService, mergeLinks, isProviderUrl };

"use strict";

/**
 * Read a single embedded JSON object, respecting strings and nested braces.
 * Never evaluate script from an upstream page.
 * @param {string} source
 * @param {number} openBrace
 * @returns {Record<string, any> | null}
 */
function parseEmbeddedJsonObject(source, openBrace) {
  if (source[openBrace] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBrace; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(source.slice(openBrace, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * @param {string} html
 * @param {{expectedChannelPath?: string}} [opts]
 * @returns {string[] | null}
 */
function extractChannelLiveVideoIds(html, opts = {}) {
  const assignment = /(?:\b(?:var\s+)?ytInitialData|window\["ytInitialData"\])\s*=\s*\{/.exec(html);
  if (!assignment) return null;
  const data = parseEmbeddedJsonObject(html, html.indexOf("{", assignment.index));
  const selected = selectedChannelStreamsTab(data, opts.expectedChannelPath);
  const contents = selected?.content?.richGridRenderer?.contents
    ?? selected?.content?.sectionListRenderer?.contents;
  if (!Array.isArray(contents)) return null;

  const ids = new Set();
  const pending = [...contents];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    const lockup = item.lockupViewModel;
    const video = item.videoRenderer || item.gridVideoRenderer;
    if (lockup || video) {
      // Only the card's own live badge qualifies. Titles, descriptions,
      // upcoming reminders, and unrelated page recommendations do not.
      const id = lockup?.contentId ?? video?.videoId;
      const badges = lockup
        ? lockup.contentImage?.thumbnailViewModel?.overlays
        : [video.thumbnailOverlays, video.badges];
      if (
        typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id) &&
        (!lockup || lockup.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") &&
        hasLiveBadge(badges)
      ) ids.add(id);
      continue;
    }
    // Follow only the channel's known listing wrappers. Shelves, ad slots,
    // and recommendation modules inside the selected tab can contain live
    // videos owned by other channels and must never become chat sessions.
    if (item.richItemRenderer?.content) {
      pending.push(item.richItemRenderer.content);
    } else if (Array.isArray(item.itemSectionRenderer?.contents)) {
      pending.push(...item.itemSectionRenderer.contents);
    } else if (Array.isArray(item.gridRenderer?.items)) {
      pending.push(...item.gridRenderer.items);
    }
  }
  return [...ids].reverse();
}

/**
 * @param {Record<string, any> | null} data
 * @param {string | undefined} expectedPath
 * @returns {Record<string, any> | null}
 */
function selectedChannelStreamsTab(data, expectedPath) {
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs;
  if (!Array.isArray(tabs)) return null;
  const selected = tabs.find((tab) => tab?.tabRenderer?.selected)?.tabRenderer;
  const url = selected?.endpoint?.commandMetadata?.webCommandMetadata?.url;
  // A consent page, redirect to Home, or changed schema is not proof of offline.
  if (typeof url !== "string") return null;
  let selectedUrl;
  try {
    selectedUrl = new URL(url, "https://www.youtube.com");
  } catch {
    return null;
  }
  if (
    selectedUrl.protocol !== "https:" ||
    !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(selectedUrl.hostname) ||
    selectedUrl.username || selectedUrl.password || selectedUrl.port ||
    !/^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)\/streams\/?$/.test(selectedUrl.pathname)
  ) return null;
  const selectedPath = selectedUrl.pathname.replace(/\/streams\/?$/, "");
  if (expectedPath?.startsWith("/@") && selectedPath.toLowerCase() !== expectedPath.toLowerCase()) {
    return null;
  }
  if (expectedPath?.startsWith("/channel/")) {
    const expectedId = expectedPath.slice("/channel/".length);
    const actualId = data?.metadata?.channelMetadataRenderer?.externalId;
    if (actualId ? actualId !== expectedId : selectedPath !== expectedPath) return null;
  }
  // Legacy /c and /user URLs can canonicalize to a handle. When YouTube keeps
  // that legacy form in its selected endpoint, it must still match the input.
  if (
    expectedPath && /^\/(?:c|user)\//.test(expectedPath) &&
    /^\/(?:c|user)\//.test(selectedPath) &&
    selectedPath.toLowerCase() !== expectedPath.toLowerCase()
  ) return null;
  return selected;
}

/** @param {unknown} badges @returns {boolean} */
function hasLiveBadge(badges) {
  const pending = [badges];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    const entry = /** @type {Record<string, any>} */ (item);
    if (
      entry.thumbnailBadgeViewModel?.badgeStyle === "THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE" ||
      entry.thumbnailOverlayTimeStatusRenderer?.style === "LIVE" ||
      entry.metadataBadgeRenderer?.style === "BADGE_STYLE_TYPE_LIVE_NOW"
    ) return true;
    pending.push(...Object.values(entry));
  }
  return false;
}

/**
 * Explicit player state only: missing live fields on an error/consent page
 * cannot establish zero viewers. Waiting rooms are not active broadcasts.
 * @param {string} html
 * @returns {boolean | null}
 */
function extractWatchLiveState(html) {
  for (const match of html.matchAll(/"liveBroadcastDetails"\s*:\s*\{/g)) {
    const details = parseEmbeddedJsonObject(html, html.indexOf("{", match.index));
    if (typeof details?.isLiveNow === "boolean") return details.isLiveNow;
  }
  for (const match of html.matchAll(/"videoDetails"\s*:\s*\{/g)) {
    const details = parseEmbeddedJsonObject(html, html.indexOf("{", match.index));
    if (!details?.videoId) continue;
    if (details.isUpcoming === true) return false;
    if (typeof details.isLive === "boolean") return details.isLive;
    if (details.isLiveContent === false) return false;
  }
  return null;
}

module.exports = {
  parseEmbeddedJsonObject,
  extractChannelLiveVideoIds,
  extractWatchLiveState,
};

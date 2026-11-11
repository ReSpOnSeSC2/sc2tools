"use strict";

const { isProviderUrl } = require("./gameVodLinks");

/** Drop credentials, tracking parameters and any previous timestamp.
 * @param {unknown} raw */
function streamVodUrl(raw) {
  if (typeof raw !== "string" || raw.length > 300) return null;
  const text = raw.trim();
  if (isProviderUrl("twitch", text)) {
    const path = new URL(text).pathname.replace(/\/$/, "");
    return `https://www.twitch.tv${path}`;
  }
  if (isProviderUrl("youtube", text)) {
    const url = new URL(text);
    const id = url.hostname.replace(/^www\./, "") === "youtu.be" ? url.pathname.split("/")[1] : url.searchParams.get("v");
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return null;
}

module.exports = { streamVodUrl };

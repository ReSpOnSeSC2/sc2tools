"use strict";

const { readAll } = require("./read");
const { transform } = require("./transform");

/**
 * Compare local record counts to cloud record counts. Useful as a
 * post-migration sanity check.
 *
 * @param {{
 *   local: string,
 *   api: string,
 *   token: string,
 *   log: (level: string, msg: string) => void,
 * }} args
 */
async function reconcile({ local, api, token, log }) {
  log("info", "reading local files for reconcile...");
  const raw = await readAll(local);
  const xform = transform(raw);

  log("info", "fetching cloud counts...");
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };

  const games = await countCloud(`${api}/v1/games`, headers, log);
  const opponents = await countCloud(`${api}/v1/opponents`, headers, log);
  const customBuilds = await countCloud(`${api}/v1/custom-builds`, headers, log);

  return {
    local: {
      games: xform.games.length,
      customBuilds: xform.customBuilds.length,
      opponents: raw.opponentsCount,
    },
    cloud: { games, opponents, customBuilds },
    diff: {
      games: games.total === null ? null : games.total - xform.games.length,
      opponents:
        opponents.total === null ? null : opponents.total - raw.opponentsCount,
      customBuilds:
        customBuilds.total === null
          ? null
          : customBuilds.total - xform.customBuilds.length,
    },
  };
}

async function countCloud(url, headers, log) {
  let total = 0;
  let cursor = null;
  let pages = 0;
  const PAGE = 100;
  try {
    do {
      const u = new URL(url);
      u.searchParams.set("limit", String(PAGE));
      if (cursor) u.searchParams.set("before", cursor);
      const res = await fetch(u, { headers });
      if (!res.ok) {
        log("warn", `${url} -> ${res.status}; aborting count`);
        return { total: null, error: res.status };
      }
      const json = await res.json();
      const items = (json && json.items) || [];
      total += items.length;
      cursor =
        json && json.nextBefore
          ? typeof json.nextBefore === "string"
            ? json.nextBefore
            : new Date(json.nextBefore).toISOString()
          : null;
      pages += 1;
      if (pages > 200) {
        log("warn", `>${pages} pages walking ${url} — bailing out`);
        return { total: null, error: "too_many_pages" };
      }
    } while (cursor);
    return { total };
  } catch (err) {
    return { total: null, error: String((err && err.message) || err) };
  }
}

module.exports = { reconcile };

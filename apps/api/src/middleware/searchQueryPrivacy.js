"use strict";

// Request URLs whose query string carries text a person typed into search: the
// quick-search palette's recent-games read of the replay library, and the
// signed-out Community quick search (ADR 0069, 2026-11-01 amendment). Logs,
// reports and Sentry keep the route and every other parameter, with these
// values redacted. A parameter counts by the key Express's qs parser reads it
// as, so search[], search[0] and [search] are all `search`.
const SEARCH_QUERY_ROUTES = Object.freeze([
  Object.freeze({ path: /^\/v1\/replays\/?$/iu, root: "search" }),
  Object.freeze({ path: /^\/v1\/community\/builds\/?$/iu, root: "q" }),
]);
const SEARCH_QUERY_HINT = /\/v1\/(?:replays|community\/builds)/iu;
const BASE = "http://request.invalid";

// Mongo comments on reads whose filter holds typed search text. A failed read
// with one of these comments is logged by code only (db/connect.js).
const REPLAY_SEARCH_COMMENT = "sc2tools-replay-search-v1";
const COMMUNITY_SEARCH_COMMENT = "sc2tools-community-search-v1";

/**
 * The key qs reads a decoded parameter name as: everything before its first
 * bracket, or the first bracket's contents when the name starts with one.
 * Example: queryRoot("search[0]") === queryRoot("[search]") === "search".
 * @param {string} name @returns {string}
 */
function queryRoot(name) {
  const open = name.indexOf("[");
  if (open > 0) return name.slice(0, open);
  const close = open === 0 ? name.indexOf("]") : -1;
  return close > 0 ? name.slice(1, close) : name;
}

/** A predicate for the typed-search parameter names of a route, or null for any other route.
 * Letter case is ignored, so the rule redacts more than qs would read, never less.
 * @param {string} pathname @returns {((name: string) => boolean)|null} */
function searchKeyFor(pathname) {
  const route = SEARCH_QUERY_ROUTES.find(entry => entry.path.test(pathname));
  return route ? name => queryRoot(name).toLowerCase() === route.root : null;
}

/**
 * Redact typed-search values in place. Returns whether the URL carried one.
 * Example: redactSearchQuery(new URL("/v1/replays?search=Bob&limit=5", base))
 * leaves "/v1/replays?search=%5Bredacted%5D&limit=5" and returns true.
 * @param {URL} url @returns {boolean}
 */
function redactSearchQuery(url) {
  const isSearch = searchKeyFor(url.pathname);
  if (!isSearch) return false;
  let found = false;
  for (const name of new Set(url.searchParams.keys())) {
    if (!isSearch(name)) continue;
    url.searchParams.set(name, "[redacted]");
    found = true;
  }
  return found;
}

/**
 * Whether a request URL, absolute or a path with its query, carries typed search
 * text. A URL that cannot be parsed counts when its path looks like one of these routes.
 * Example: isSearchQueryUrl("/v1/replays?search=Bob") === true; "/v1/replays?limit=5" is false.
 * @param {unknown} value @returns {boolean}
 */
function isSearchQueryUrl(value) {
  if (typeof value !== "string" || !SEARCH_QUERY_HINT.test(value)) return false;
  try { return redactSearchQuery(new URL(value, BASE)); }
  catch { return true; }
}

/**
 * Parameter names of a query string as Sentry records it: a string, a record or
 * [key, value] pairs. Null for any other shape.
 * @param {unknown} queryString @returns {string[]|null}
 */
function queryNames(queryString) {
  if (typeof queryString === "string") return [...new URLSearchParams(queryString).keys()];
  if (Array.isArray(queryString)) return queryString.map(pair => String(Array.isArray(pair) ? pair[0] : pair));
  return queryString && typeof queryString === "object" ? Object.keys(queryString) : null;
}

/**
 * Sentry keeps an incoming request's query apart from its URL. True when `url`
 * names one of these routes and either it or `queryString` carries a
 * typed-search key; an unreadable shape counts.
 * @param {unknown} url @param {unknown} queryString @returns {boolean}
 */
function requestCarriesSearchQuery(url, queryString) {
  if (isSearchQueryUrl(url)) return true;
  if (typeof url !== "string" || queryString === undefined || queryString === null) return false;
  let isSearch;
  try { isSearch = searchKeyFor(new URL(url, BASE).pathname); }
  catch { return SEARCH_QUERY_HINT.test(url); }
  if (!isSearch) return false;
  const matches = isSearch;
  try {
    const names = queryNames(queryString);
    return names === null || names.some(name => matches(name));
  } catch { return true; }
}

module.exports = {
  COMMUNITY_SEARCH_COMMENT,
  REPLAY_SEARCH_COMMENT,
  SEARCH_QUERY_ROUTES,
  isSearchQueryUrl,
  queryRoot,
  redactSearchQuery,
  requestCarriesSearchQuery,
};

"use strict";

const {
  isPrivateSearchPath, isPrivateSearchRequest, isPrivateSearchFailure,
} = require("./privateSearchBoundary");
const { isSearchQueryUrl, requestCarriesSearchQuery } = require("./searchQueryPrivacy");
const PRIVATE_SEARCH_TAG = "sc2tools.private_search";
const HEARTBEAT_PATH = /^\/v1\/devices\/heartbeat\/?$/i;

/** @param {unknown} value @param {string} key @returns {unknown} */
function ownData(value, key) {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && Object.hasOwn(field, "value") ? field.value : undefined;
  } catch { return undefined; }
}

/** @param {unknown} value @returns {boolean} */
function privateTransaction(value) {
  if (typeof value !== "string") return false;
  const path = value.replace(/^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, "");
  return isPrivateSearchPath(path);
}

/** The device heartbeat body carries the agent's sync report, whose unresolved names
 * are players' names and toon handles, so Sentry never keeps it.
 * Example: isHeartbeatBodyPath("https://api.example/v1/devices/heartbeat?x=1") === true.
 * @param {unknown} value @returns {boolean} */
function isHeartbeatBodyPath(value) {
  if (typeof value !== "string") return false;
  const end = value.search(/[?#]/);
  return HEARTBEAT_PATH.test((end < 0 ? value : value.slice(0, end)).replace(/^https?:\/\/[^/]+(?=\/)/i, ""));
}

/** A heartbeat event keeps its URL and status but never its body, on either request copy.
 * @param {unknown} event */
function stripHeartbeatBody(event) {
  for (const request of [ownData(event, "request"), ownData(ownData(event, "sdkProcessingMetadata"), "normalizedRequest")]) {
    if (request && typeof request === "object" && isHeartbeatBodyPath(ownData(request, "url"))) {
      delete /** @type {{data?: unknown}} */ (request).data;
    }
  }
}

/** Private quick search, or a request URL whose query carries typed search text.
 * @param {unknown} request @returns {boolean} */
function privateRequest(request) {
  const url = ownData(request, "url");
  return isPrivateSearchPath(url) || requestCarriesSearchQuery(url, ownData(request, "query_string"));
}

/**
 * Drop the whole known-private event, not only its exception message.
 * Example: shouldDropPrivateSearchEvent({request:{url:"/v1/search/quick"}}) === true.
 * Typed search in a replay-library or Community quick-search URL is private too.
 * Missing URL is covered by the request-local constant tag or original safe error.
 * @param {unknown} event @param {unknown} [hint] @returns {boolean}
 */
function shouldDropPrivateSearchEvent(event, hint) {
  if (isPrivateSearchFailure(ownData(hint, "originalException"))) return true;
  const tag = ownData(ownData(event, "tags"), PRIVATE_SEARCH_TAG);
  if (tag === "1" || tag === true) return true;
  if (privateRequest(ownData(event, "request"))) return true;
  const metadata = ownData(event, "sdkProcessingMetadata");
  return privateRequest(ownData(metadata, "normalizedRequest"))
    || privateTransaction(ownData(event, "transaction"));
}

/** Keep unrelated events by identity; private events are omitted entirely.
 * Example: beforeSendPrivateSearch(event, hint) can be passed to the optional SDK.
 * @template T @param {T} event @param {unknown} [hint] @returns {T|null}
 */
function beforeSendPrivateSearch(event, hint) {
  if (shouldDropPrivateSearchEvent(event, hint)) return null;
  stripHeartbeatBody(event);
  return event;
}

/**
 * SDK option callbacks only. Does not import/init/call Sentry.
 * Both hooks are required: exception and transaction pipelines are different.
 * Example: Object.assign(sentryOptions, privateSearchSentryCallbacks()).
 */
function privateSearchSentryCallbacks() {
  return { beforeSend: beforeSendPrivateSearch, beforeSendTransaction: beforeSendPrivateSearch };
}

/**
 * Pass to the existing SDK Http integration before app/parser creation.
 * Avoids pre-parser body capture for this route, and incoming server spans for
 * it and for request URLs whose query carries typed search text.
 * Example: sdk.httpIntegration(privateSearchHttpOptions()) during optional init.
 */
function privateSearchHttpOptions() {
  return {
    /** @param {string} urlPath */
    ignoreIncomingRequestBody: urlPath => isPrivateSearchPath(urlPath) || isHeartbeatBodyPath(urlPath),
    /** @param {string} urlPath the path and query string */
    ignoreIncomingRequests: urlPath => isPrivateSearchPath(urlPath) || isSearchQueryUrl(urlPath),
  };
}

/** Run the actual private request chain in its own SDK scope. No shared
 * request/query state is retained and no SDK is initialized here. A request
 * whose URL carries typed search text gets the same scope.
 * @param {{originalUrl?:unknown,url?:unknown}} req
 * @param {()=>void} next
 * @param {Pick<typeof import('@sentry/node'), 'withIsolationScope'|'suppressTracing'>|false} sdk
 */
function runPrivateSearchScope(req, next, sdk) {
  if (!sdk || !(isPrivateSearchRequest(req) || isSearchQueryUrl(req.originalUrl || req.url))) { next(); return; }
  sdk.withIsolationScope(scope => {
    scope.setTag(PRIVATE_SEARCH_TAG, "1");
    sdk.suppressTracing(next);
  });
}

module.exports = {
  PRIVATE_SEARCH_TAG, shouldDropPrivateSearchEvent, beforeSendPrivateSearch, isHeartbeatBodyPath,
  privateSearchSentryCallbacks, privateSearchHttpOptions, runPrivateSearchScope,
};

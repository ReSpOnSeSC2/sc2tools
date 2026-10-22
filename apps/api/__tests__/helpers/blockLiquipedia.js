"use strict";

// Jest ``setupFiles`` entry (jest.config.js): no suite may reach
// Liquipedia.
//
// LadderMapPoolService defaults to ``globalThis.fetch`` and persists
// each successful fetch into the committed seed file
// data/ladder-map-pool.json. buildApp() constructs one with those
// defaults (via SeasonsService) and POST /v1/games reads the pool on
// every ingest, so any full-app suite that ingested a game used to
// fetch the live page and rewrite the seed's ``fetchedAt``.
//
// Requests to liquipedia.net reject here like a network failure: the
// service falls back to reading the seed file and never writes it.
// The service's own suite injects ``fetchImpl`` + a temp
// ``persistPath`` and is unaffected. Every other URL passes through.

const realFetch = globalThis.fetch;

/** @param {Parameters<typeof fetch>[0]} input */
function isLiquipedia(input) {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return /(^|\.)liquipedia\.net$/i.test(new URL(raw).hostname);
  } catch {
    return false;
  }
}

if (typeof realFetch === "function") {
  /** @type {typeof fetch} */
  const fetchWithoutLiquipedia = async (input, init) => {
    if (isLiquipedia(input)) {
      throw new TypeError("liquipedia_fetch_disabled_in_tests");
    }
    return realFetch(input, init);
  };
  globalThis.fetch = fetchWithoutLiquipedia;
}

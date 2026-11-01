// @ts-nocheck
"use strict";

const {
  isSearchQueryUrl, redactSearchQuery, requestCarriesSearchQuery,
} = require("../src/middleware/searchQueryPrivacy");
const { sanitiseRequestUrl } = require("../src/middleware/requestLogging");
const {
  shouldDropPrivateSearchEvent, privateSearchHttpOptions, runPrivateSearchScope, PRIVATE_SEARCH_TAG,
} = require("../src/middleware/privateSearchTelemetry");

describe("typed search in request URLs (ADR 0069 amendment)", () => {
  // The web report sanitiser's test (lib/feedback/__tests__/sanitise.test.ts) shares the first six rows.
  test.each([
    ["/v1/replays?search=Rival&limit=5&sort=date_desc&enrich=none&window=recent",
      "/v1/replays?search=%5Bredacted%5D&limit=5&sort=date_desc&enrich=none&window=recent"],
    ["/v1/replays?search[]=Rival&limit=5", "/v1/replays?search%5B%5D=%5Bredacted%5D&limit=5"],
    ["/v1/community/builds?view=quick&q=Stargate&limit=8", "/v1/community/builds?view=quick&q=%5Bredacted%5D&limit=8"],
    ["/v1/replays/g-1?search=keep", "/v1/replays/g-1?search=keep"],
    ["/v1/replays?[search]=Rival&%5Bsearch%5D%5B0%5D=Bob&[search=keep", "/v1/replays?%5Bsearch%5D=%5Bredacted%5D&%5Bsearch%5D%5B0%5D=%5Bredacted%5D&%5Bsearch=keep"],
    ["/v1/community/builds?view=quick&[q]=Stargate", "/v1/community/builds?view=quick&%5Bq%5D=%5Bredacted%5D"],
    ["https://api.example.test/V1/REPLAYS/?search[]=Rival&search[0]=Bob&limit=5",
      "/V1/REPLAYS/?search%5B%5D=%5Bredacted%5D&search%5B0%5D=%5Bredacted%5D&limit=5"],
    ["/v1/replays?se%61rch=Rival", "/v1/replays?search=%5Bredacted%5D"],
    ["/v1/replays?limit=5&searchable=keep", "/v1/replays?limit=5&searchable=keep"],
    ["/v1/community/builds?q=zerg&sort=top", "/v1/community/builds?q=%5Bredacted%5D&sort=top"],
    ["/v1/community/builds/build-abc?q=keep", "/v1/community/builds/build-abc?q=keep"],
  ])("request logs keep the route and redact the typed text: %s", (input, expected) => {
    expect(sanitiseRequestUrl(input)).toBe(expected);
  });

  test("recognizes only the two search routes and only when they carry text", () => {
    expect(isSearchQueryUrl("/v1/replays?search=Rival")).toBe(true);
    expect(isSearchQueryUrl("/v1/community/builds?view=quick&q=x")).toBe(true);
    expect(isSearchQueryUrl("/v1/replays?limit=5")).toBe(false);
    expect(isSearchQueryUrl("/v1/games?search=Rival")).toBe(false);
    expect(isSearchQueryUrl(undefined)).toBe(false);
    const url = new URL("http://request.invalid/v1/replays?search=a&search=b&limit=5");
    expect(redactSearchQuery(url)).toBe(true);
    expect(url.search).toBe("?search=%5Bredacted%5D&limit=5");
  });

});

describe("typed search and Sentry (ADR 0069 amendment)", () => {
  test("Sentry's separate query string counts in every shape it takes", () => {
    expect(requestCarriesSearchQuery("/v1/replays", "search=Rival&limit=5")).toBe(true);
    expect(requestCarriesSearchQuery("https://api.example.test/v1/replays", { search: "Rival" })).toBe(true);
    expect(requestCarriesSearchQuery("/v1/community/builds", [["q", "x"], ["limit", "8"]])).toBe(true);
    expect(requestCarriesSearchQuery("/v1/replays", 42)).toBe(true);
    expect(requestCarriesSearchQuery("/v1/replays", "limit=5")).toBe(false);
    expect(requestCarriesSearchQuery("/v1/games", "search=Rival")).toBe(false);
    expect(requestCarriesSearchQuery("/v1/replays", undefined)).toBe(false);
  });

  test("Sentry drops those events, takes no span for those requests and runs them in the private scope", () => {
    expect(shouldDropPrivateSearchEvent({ request: { url: "https://api.example.test/v1/replays?search=Rival" } })).toBe(true);
    expect(shouldDropPrivateSearchEvent({ request: { url: "https://api.example.test/v1/replays", query_string: "search=Rival" } })).toBe(true);
    expect(shouldDropPrivateSearchEvent({ sdkProcessingMetadata: { normalizedRequest: {
      url: "/v1/community/builds", query_string: { view: "quick", q: "x" } } } })).toBe(true);
    const kept = { request: { url: "https://api.example.test/v1/replays", query_string: "limit=5" } };
    expect(shouldDropPrivateSearchEvent(kept)).toBe(false);

    const { ignoreIncomingRequests } = privateSearchHttpOptions();
    expect(ignoreIncomingRequests("/v1/replays?search=Rival")).toBe(true);
    expect(ignoreIncomingRequests("/v1/community/builds?view=quick&q=x")).toBe(true);
    expect(ignoreIncomingRequests("/v1/replays?limit=5")).toBe(false);

    const tags = {};
    const sdk = {
      withIsolationScope: run => run({ setTag: (key, value) => { tags[key] = value; } }),
      suppressTracing: jest.fn(next => next()),
    };
    const next = jest.fn();
    runPrivateSearchScope({ originalUrl: "/v1/replays?search=Rival&window=recent" }, next, sdk);
    expect(tags[PRIVATE_SEARCH_TAG]).toBe("1");
    expect(sdk.suppressTracing).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    runPrivateSearchScope({ originalUrl: "/v1/replays?limit=5" }, next, sdk);
    expect(sdk.suppressTracing).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

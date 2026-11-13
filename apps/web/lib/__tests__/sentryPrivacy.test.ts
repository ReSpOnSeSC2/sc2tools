import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubSpan, scrubTransaction } from "../sentryPrivacy";

it.each([
  ["/card/report/summary", "/card/report/summary"], ["/card/r%65port/%73ummary", "/card/report/summary"],
  ["/card/report/compare", "/card/report/compare"], ["/card/r%65port/c%6Fmpare", "/card/report/compare"],
])("drops card fragments from navigation breadcrumbs after leaving %s", (path, canonical) => {
  const crumb = { category: "navigation", data: { from: `https://sc2tools.com${path}#PrivateData`, to: "/try" } };
  expect(scrubBreadcrumb(crumb).data).toEqual({ from: canonical, to: "/try" });
  expect(crumb.data.from).toContain("#PrivateData");
});

const SEARCH = "https://api.sc2tools.com/v1/replays?search=Private%20Rival&limit=5&sort=date_desc&enrich=none&window=recent";
const SCRUBBED = "/v1/replays?search=%5Bredacted%5D&limit=5&sort=date_desc&enrich=none&window=recent";

describe("browser Sentry keeps no typed search text or credential path", () => {
  it("removes viewer handles and query values from navigation, request, span and transaction context", () => {
    const page = "/p/private-handle-0123456789/live";
    const url = "https://api.sc2tools.com/v1/public/players/private-handle-0123456789/live?private=value";
    const expected = "/v1/public/players/:slug/live";
    expect(scrubBreadcrumb({ category: "navigation", data: { from: page, to: "/try" } }).data?.from).toBe("/p/:handle/live");
    expect(scrubSpan({ description: `GET ${url}`, data: { url } })).toEqual({ description: `GET ${expected}`, data: { url: expected } });
    expect(scrubTransaction({ transaction: `pageload ${page}`, request: { url: page, headers: { Referer: page } } }))
      .toEqual({ transaction: "/p/:handle/live", request: { url: "/p/:handle/live", headers: { Referer: "/p/:handle/live" } } });
  });
  it("keeps only the opponent list route in navigation, fetch and span URLs", () => {
    const url = "https://sc2tools.com/app/opponents?opponentFilter=Fixture+Rival&q=Legacy&sort=name";
    const other = "/app/opponents/rival?q=keep";
    expect(scrubBreadcrumb({ category: "navigation", data: { from: url, to: other } }).data)
      .toEqual({ from: "/app/opponents", to: other });
    expect(scrubBreadcrumb({ category: "fetch", data: { url: url.replace("?", "/?") + "&_rsc=flight" } }).data.url)
      .toBe("/app/opponents");
    expect(scrubSpan({ description: `GET ${url}`, data: { "url.full": url } })).toEqual({
      description: "GET /app/opponents", data: { "url.full": "/app/opponents" },
    });
    expect(scrubSpan({ data: { "http.request.header.referer": url } }).data)
      .toEqual({ "http.request.header.referer": "/app/opponents" });
    expect(scrubSpan({ data: { "http.request.header.referer": other } }).data)
      .toEqual({ "http.request.header.referer": other });
  });

  it("scrubs transaction request context as well as child spans", () => {
    const url = "/app/opponents?q=Old+Fixture";
    const event = { request: { url, headers: { Referer: url } }, spans: [{ data: { "http.target": url } }] };
    expect(scrubTransaction(event)).toEqual({
      request: { url: "/app/opponents", headers: { Referer: "/app/opponents" } },
      spans: [{ data: { "http.target": "/app/opponents" } }],
    });
  });

  it("strips Match Room fragments and polling credentials from telemetry", () => {
    const from = "https://sc2tools.com/match/%72oom#r=private&key=private";
    expect(scrubBreadcrumb({ category: "navigation", data: { from, to: "/match" } }).data)
      .toEqual({ from: "/match/room", to: "/match" });
    const url = "https://api.sc2tools.com/v1/match-rooms/private?rev=2";
    expect(scrubSpan({ description: `GET ${url}`, data: { url } })).toEqual({
      description: "GET /v1/match-rooms/[redacted]?rev=2",
      data: { url: "/v1/match-rooms/[redacted]?rev=2" },
    });
  });
  it.each(["/b/local-alias", "/%62/local-alias"])("normalizes Practice Link telemetry from %s", path => {
    const url = `https://sc2tools.com${path}?state=private#private`;
    expect(scrubBreadcrumb({ category: "navigation", data: { from: url, to: "/try" } }).data)
      .toEqual({ from: "/b/:alias", to: "/try" });
    expect(scrubBreadcrumb({ category: "fetch", data: { url } }).data?.url).toBe("/b/:alias");
    expect(scrubSpan({ description: `GET ${url}`, data: { url } })).toEqual({ description: "GET /b/:alias", data: { url: "/b/:alias" } });
  });
  it("scrubs fetch and XHR breadcrumb URLs and leaves other breadcrumbs alone", () => {
    expect(scrubBreadcrumb({ category: "fetch", data: { method: "GET", url: SEARCH, status_code: 200 } }))
      .toEqual({ category: "fetch", data: { method: "GET", url: SCRUBBED, status_code: 200 } });
    expect(scrubBreadcrumb({ category: "xhr", data: { url: "https://api.sc2tools.com/v1/community/builds?view=quick&q=zerg" } }).data?.url)
      .toBe("/v1/community/builds?view=quick&q=%5Bredacted%5D");
    expect(scrubBreadcrumb({ category: "fetch", data: { url: "https://api.sc2tools.com/v1/multichat/secret-token/config" } }).data?.url)
      .toBe("/v1/multichat/[redacted]/config");
    const navigation = { category: "navigation", data: { from: "/app", to: "/app/maps" } };
    expect(scrubBreadcrumb(navigation)).toBe(navigation);
  });
  it("scrubs a request span's URL fields and name and drops its separate query", () => {
    const span = scrubSpan({ description: `GET ${SEARCH}`, data: { url: SEARCH, "http.url": SEARCH, "url.full": SEARCH,
      "http.query": "?search=Private%20Rival", "http.method": "GET", "http.response.status_code": 200 } });
    expect(span).toEqual({ description: `GET ${SCRUBBED}`, data: { url: SCRUBBED, "http.url": SCRUBBED, "url.full": SCRUBBED,
      "http.method": "GET", "http.response.status_code": 200 } });
    expect(JSON.stringify(span)).not.toContain("Private");
    expect(scrubSpan({ description: "pageload /app/maps" })).toEqual({ description: "pageload /app/maps" });
  });
  it("scrubs every child span of a transaction event", () => {
    const event = scrubTransaction({ type: "transaction", spans: [{ description: `GET ${SEARCH}` }, { description: "resource.script" }] });
    expect(event.spans?.map(span => span.description)).toEqual([`GET ${SCRUBBED}`, "resource.script"]);
  });
});

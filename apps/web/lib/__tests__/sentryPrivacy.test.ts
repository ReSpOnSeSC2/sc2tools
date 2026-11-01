import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubSpan, scrubTransaction } from "../sentryPrivacy";

const SEARCH = "https://api.sc2tools.com/v1/replays?search=Private%20Rival&limit=5&sort=date_desc&enrich=none&window=recent";
const SCRUBBED = "/v1/replays?search=%5Bredacted%5D&limit=5&sort=date_desc&enrich=none&window=recent";

describe("browser Sentry keeps no typed search text or credential path", () => {
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

import { describe, expect, it } from "vitest";
import {
  REPORT_CONTEXT_MAX_BYTES,
  agentStatusFrom,
  collectReportContext,
  describeBrowser,
  pickReportContext,
  reportContextBytes,
  reportContextItems,
  webBuildSha,
  type ReportContext,
  type ReportContextItemId,
} from "../reportContext";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

describe("describeBrowser", () => {
  it.each([
    [CHROME_WINDOWS, "Chrome 129 on Windows"],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
      "Edge 129 on Windows",
    ],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox 131 on macOS"],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
      "Safari 17 on iOS",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
      "Chrome 129 on Android",
    ],
    ["curl/8.0", "Unknown browser"],
  ])("%s", (ua, expected) => {
    expect(describeBrowser(ua)).toBe(expected);
  });
});

describe("agentStatusFrom", () => {
  it("reads the heartbeat freshness", () => {
    expect(agentStatusFrom({ agentPaired: false }, NOW)).toBe("not_paired");
    expect(agentStatusFrom({ agentPaired: true, agentLastSeenAt: new Date(NOW - 30_000).toISOString() }, NOW)).toBe("online");
    expect(agentStatusFrom({ agentPaired: true, agentLastSeenAt: new Date(NOW - 600_000).toISOString() }, NOW)).toBe("offline");
    expect(agentStatusFrom({ agentPaired: true, agentLastSeenAt: null }, NOW)).toBe("offline");
  });
});

describe("webBuildSha", () => {
  it("shortens the commit and is absent in local dev", () => {
    expect(webBuildSha("4f9c2ab1d0e3c6a7b8d9e0f1a2b3c4d5e6f7a8b9")).toBe("4f9c2ab1d0e3");
    expect(webBuildSha("")).toBeUndefined();
    expect(webBuildSha(undefined)).toBeUndefined();
  });
});

function fullContext(): ReportContext {
  return collectReportContext({
    pathname: "/app/opponents/1-S2-1-99?tab=games",
    userAgent: CHROME_WINDOWS,
    viewport: { width: 1440, height: 900 },
    failedRequests: [
      { path: "/v1/me", status: 502, code: "bad_gateway" },
      { path: "/v1/games", status: 500, code: "internal_error", requestId: "req_2" },
    ],
    me: { agentPaired: true, agentVersion: "0.19.0", agentLastSeenAt: new Date(NOW - 10_000).toISOString() },
    build: "4f9c2ab1d0e3",
    now: NOW,
  });
}

describe("collectReportContext and its display", () => {
  it("collects every item, with the page's query string removed", () => {
    expect(fullContext()).toEqual({
      page: "/app/opponents/1-S2-1-99",
      build: "4f9c2ab1d0e3",
      browser: "Chrome 129 on Windows",
      viewport: "1440x900",
      agentStatus: "online",
      agentVersion: "0.19.0",
      failedRequests: [
        { path: "/v1/me", status: 502, code: "bad_gateway" },
        { path: "/v1/games", status: 500, code: "internal_error", requestId: "req_2" },
      ],
    });
  });

  it("lists what is sent in plain words, newest error first", () => {
    expect(reportContextItems(fullContext())).toEqual([
      { id: "page", label: "Page", value: "/app/opponents/1-S2-1-99" },
      { id: "build", label: "Site version", value: "4f9c2ab1d0e3" },
      { id: "browser", label: "Browser", value: "Chrome 129 on Windows" },
      { id: "viewport", label: "Window size", value: "1440 × 900" },
      { id: "agent", label: "Desktop app", value: "v0.19.0, online" },
      {
        id: "requests",
        label: "Recent errors",
        value: "2 failed requests",
        details: ["500 · /v1/games · internal_error · ref req_2", "502 · /v1/me · bad_gateway"],
      },
    ]);
  });

  it("leaves out what it doesn't know", () => {
    const context = collectReportContext({
      pathname: "/settings",
      userAgent: "",
      viewport: { width: 0, height: 0 },
      failedRequests: [],
      now: NOW,
    });
    expect(context).toEqual({ page: "/settings" });
    const unpaired = collectReportContext({
      pathname: "/app",
      userAgent: "",
      viewport: { width: 390, height: 844 },
      failedRequests: [],
      me: { agentPaired: false, agentVersion: "0.1.0" },
      now: NOW,
    });
    expect(reportContextItems(unpaired).find((item) => item.id === "agent")?.value).toBe("Not paired");
    expect(unpaired.agentVersion).toBeUndefined();
  });
});

describe("pickReportContext", () => {
  it("sends only the ticked items", () => {
    const excluded = new Set<ReportContextItemId>(["page", "agent", "requests"]);
    expect(pickReportContext(fullContext(), excluded)).toEqual({
      build: "4f9c2ab1d0e3",
      browser: "Chrome 129 on Windows",
      viewport: "1440x900",
    });
  });

  it("sends nothing when every item is unticked", () => {
    const all = new Set<ReportContextItemId>(["page", "build", "browser", "viewport", "agent", "requests"]);
    expect(pickReportContext(fullContext(), all)).toBeUndefined();
  });

  it("drops the oldest failed requests to stay under 2 KB", () => {
    const context: ReportContext = {
      ...fullContext(),
      page: `/${"p".repeat(199)}`,
      browser: "b".repeat(120),
      failedRequests: Array.from({ length: 5 }, (_, i) => ({
        path: `/${String(i).repeat(159)}`,
        status: 500,
        code: "c".repeat(64),
        requestId: "r".repeat(64),
      })),
    };
    expect(reportContextBytes(context)).toBeGreaterThan(REPORT_CONTEXT_MAX_BYTES);
    const picked = pickReportContext(context, new Set())!;
    expect(reportContextBytes(picked)).toBeLessThanOrEqual(REPORT_CONTEXT_MAX_BYTES);
    expect(picked.failedRequests!.length).toBeLessThan(5);
    expect(picked.failedRequests!.at(-1)!.path.startsWith("/4")).toBe(true);
  });
});

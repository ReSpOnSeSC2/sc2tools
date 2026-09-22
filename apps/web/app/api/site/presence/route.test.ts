import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const visitorToken = `v1.${"a".repeat(43)}.1790000000000.${"b".repeat(43)}`;
const nextToken = `v1.${"c".repeat(43)}.1790000000000.${"d".repeat(43)}`;

function request(headers: Record<string, string> = {}, body = "{}") {
  return new NextRequest("https://sc2tools.test/api/site/presence", {
    method: "POST",
    headers: { host: "sc2tools.test", origin: "https://sc2tools.test", "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/site/presence", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(Response.json({ visitorToken }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SC2TOOLS_API_BASE", "https://api.sc2tools.test");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("creates an ephemeral secure HttpOnly cookie without exposing its token to JavaScript", async () => {
    const response = await POST(request());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.cookies.get("sc2tools_site_visitor")?.value).toBe(visitorToken);
    const cookie = response.headers.get("set-cookie");
    for (const flag of ["HttpOnly", "Secure", "SameSite=lax", "Max-Age=180", "Path=/"]) {
      expect(cookie).toContain(flag);
    }
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
  });

  it("reuses the browser cookie and forwards only verified-upstream identity inputs", async () => {
    const response = await POST(request({
      cookie: `sc2tools_site_visitor=${visitorToken}`,
      authorization: "Bearer clerk.jwt.signature",
      "user-agent": "private browser information",
      referer: "https://sc2tools.test/private/replay/123",
    }, JSON.stringify({ visitorToken: "untrusted-body-token", userId: "impersonation" })));
    expect(response.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledWith("https://api.sc2tools.test/v1/site/presence", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer clerk.jwt.signature" },
      body: JSON.stringify({ visitorToken }),
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  });

  it("accepts the incoming Host when Next normalizes its URL to localhost", async () => {
    const req = new NextRequest("http://localhost:3210/api/site/presence", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3210", origin: "http://127.0.0.1:3210",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const response = await POST(req);
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("recognizes HTTPS terminated by a hosting proxy and keeps the cookie secure", async () => {
    const req = new NextRequest("http://internal-next-host/api/site/presence", {
      method: "POST",
      headers: {
        host: "sc2tools.test", origin: "https://sc2tools.test",
        "x-forwarded-proto": "https", "content-type": "application/json",
      },
      body: "{}",
    });
    const response = await POST(req);
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it.each([
    [{ origin: "https://other.test" }, "{}", 403],
    [{ origin: "https://other.test", "x-forwarded-host": "other.test" }, "{}", 403],
    [{ origin: "http://sc2tools.test" }, "{}", 403],
    [{ origin: "https://sc2tools.test/private" }, "{}", 403],
    [{ host: "" }, "{}", 403],
    [{ origin: "" }, "{}", 403],
    [{ "sec-fetch-site": "cross-site" }, "{}", 403],
    [{ "content-type": "text/plain" }, "{}", 415],
    [{}, "not json", 400],
    [{}, "null", 400],
    [{}, "[]", 400],
  ] as const)("rejects invalid browser request %# without recording presence", async (headers, body, status) => {
    expect((await POST(request(headers, body))).status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews an expired signed token once, preserving the Clerk identity", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: "invalid_presence_token" } }, { status: 400 }));
    fetchMock.mockResolvedValueOnce(Response.json({ visitorToken: nextToken }));
    const response = await POST(request({ cookie: `sc2tools_site_visitor=${visitorToken}`, authorization: "Bearer clerk.jwt" }));
    expect(response.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({});
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer clerk.jwt");
    expect(response.cookies.get("sc2tools_site_visitor")?.value).toBe(nextToken);
  });

  it("clears an invalid cookie if its single renewal attempt fails", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: "invalid_presence_token" } }, { status: 400 }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const response = await POST(request({ cookie: `sc2tools_site_visitor=${visitorToken}` }));
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.cookies.get("sc2tools_site_visitor")?.value).toBe("");
  });

  it("rejects malformed upstream tokens without setting a cookie", async () => {
    fetchMock.mockResolvedValue(Response.json({ visitorToken: "not-a-signed-token" }));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not turn an upstream outage into a fabricated presence success", async () => {
    fetchMock.mockRejectedValue(new Error("upstream unavailable"));
    expect((await POST(request())).status).toBe(503);
  });
});

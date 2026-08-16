import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { forwardAgentDownloadEvent } from "./agentDownloadEvents.server";

describe("forwardAgentDownloadEvent", () => {
  const fetchMock = vi.fn();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    fetchMock.mockReset();
    consoleError.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SC2TOOLS_API_BASE", "https://api.sc2tools.test/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    consoleError.mockRestore();
  });

  it("forwards the event and original request metadata to the API", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const req = {
      headers: new Headers({
        "user-agent": "test browser",
        referer: "https://sc2tools.test/download",
        "x-forwarded-for": "203.0.113.42",
        "x-vercel-ip-country": "US",
      }),
    };

    await expect(
      forwardAgentDownloadEvent(req, {
        platform: "windows",
        version: "0.15.20",
        channel: "stable",
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.sc2tools.test/v1/agent/download-event",
    );
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "user-agent": "test browser",
      referer: "https://sc2tools.test/download",
      "x-forwarded-for": "203.0.113.42",
      "x-geo-country": "US",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      platform: "windows",
      version: "0.15.20",
      channel: "stable",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("logs non-success responses and fails open", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(
      forwardAgentDownloadEvent(
        { headers: new Headers() },
        { platform: "windows" },
      ),
    ).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledWith(
      "[agent-download-event] forward failed with 503",
    );
  });

  it("logs network errors and fails open", async () => {
    const error = new Error("network down");
    fetchMock.mockRejectedValueOnce(error);

    await expect(
      forwardAgentDownloadEvent(
        { headers: new Headers() },
        { platform: "windows" },
      ),
    ).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledWith(
      "[agent-download-event] forward failed",
      error,
    );
  });
});

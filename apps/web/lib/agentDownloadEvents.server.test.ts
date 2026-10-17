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
      downloadId: expect.stringMatching(UUID_PATTERN),
      platform: "windows",
      version: "0.15.20",
      channel: "stable",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([429, 503])("recovers from HTTP %s without changing the download ID", async (status) => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(forward()).resolves.toBe(true);

    expectRetriedDownload(fetchMock);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    new Error("connection reset after write"),
    new DOMException("Request timed out", "TimeoutError"),
  ])("recovers from %s without changing the download ID", async (error) => {
    fetchMock
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(forward()).resolves.toBe(true);

    expectRetriedDownload(fetchMock);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([400, 422])("does not retry permanent HTTP %s errors", async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));

    await expect(forward()).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      `[agent-download-event] forward failed with ${status}`,
    );
  });

  it("logs the final non-success response after two attempts and fails open", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      forwardAgentDownloadEvent(
        { headers: new Headers() },
        { platform: "windows" },
      ),
    ).resolves.toBe(false);

    expectRetriedDownload(fetchMock);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[agent-download-event] forward failed with 503",
    );
  });

  it("logs the final network error after two attempts and fails open", async () => {
    const error = new Error("network down");
    fetchMock.mockRejectedValue(error);

    await expect(
      forwardAgentDownloadEvent(
        { headers: new Headers() },
        { platform: "windows" },
      ),
    ).resolves.toBe(false);

    expectRetriedDownload(fetchMock);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith(
      "[agent-download-event] forward failed",
      error,
    );
  });

  it("uses different download IDs for separate download requests", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await forward();
    await forward();

    const first = JSON.parse(fetchMock.mock.calls[0][1].body).downloadId;
    const second = JSON.parse(fetchMock.mock.calls[1][1].body).downloadId;
    expect(first).toMatch(UUID_PATTERN);
    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
  });
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function forward() {
  return forwardAgentDownloadEvent({ headers: new Headers() }, { platform: "windows" });
}

function expectRetriedDownload(fetchMock: ReturnType<typeof vi.fn>) {
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const first = fetchMock.mock.calls[0][1] as RequestInit;
  const second = fetchMock.mock.calls[1][1] as RequestInit;
  expect(JSON.parse(String(first.body)).downloadId).toMatch(UUID_PATTERN);
  expect(second.body).toBe(first.body);
  expect(second.signal).not.toBe(first.signal);
}

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RELEASES_REVALIDATE_SECONDS,
  AGENT_RELEASES_UNAVAILABLE,
  AgentReleasesUnavailableError,
  compareAgentVersions,
  fetchLatestAgentRelease,
  latestPublishedAgentVersion,
} from "../agentReleaseSource.server";

const GITHUB_RELEASES = "https://api.github.com/repos/ReSpOnSeSC2/sc2tools/releases?per_page=30";

function release(tag: string, extra: Record<string, unknown> = {}) {
  const version = tag.replace(/^agent-v/, "");
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: "2026-11-24T17:53:30Z",
    assets: [
      { name: `SC2ToolsAgent-Setup-${version}.exe`, browser_download_url: `https://example.test/${version}.exe`, size: 1 },
    ],
    ...extra,
  };
}

const fetchMock = vi.fn();
const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => warn.mockRestore());

function answer(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  fetchMock.mockReset();
  warn.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("AGENT_RELEASES_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchLatestAgentRelease", () => {
  it("picks the newest published agent release by version, not by list order", async () => {
    answer([
      release("v1.0.0", { assets: [{ name: "SC2Tools-Setup-1.0.0.exe", browser_download_url: "", size: 1 }] }),
      release("agent-v0.3.4"),
      release("agent-v0.3.11"),
      release("agent-v0.4.0", { draft: true }),
      release("agent-v0.5.0", { prerelease: true }),
      release("agent-v0.6.0", { assets: [{ name: "SC2ToolsAgent-Setup-0.6.0.exe.sha256", browser_download_url: "", size: 1 }] }),
      release("agent-v0.7.0", { assets: undefined }),
      null,
      { name: "untagged" },
    ]);
    expect((await fetchLatestAgentRelease())?.tag_name).toBe("agent-v0.3.11");
  });

  it("returns null when no agent release is published", async () => {
    answer([release("agent-v0.4.0", { draft: true }), release("v2.0.0")]);
    expect(await fetchLatestAgentRelease()).toBeNull();
  });

  it("reads GitHub through Next's data cache with a timeout and no token by default", async () => {
    answer([]);
    await fetchLatestAgentRelease();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GITHUB_RELEASES);
    expect(init.next).toEqual({ revalidate: AGENT_RELEASES_REVALIDATE_SECONDS });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ Accept: "application/vnd.github+json", "User-Agent": "sc2tools-website" });
  });

  it("sends GITHUB_TOKEN to GitHub but never to an overridden releases URL", async () => {
    vi.stubEnv("GITHUB_TOKEN", "secret-token");
    answer([]);
    await fetchLatestAgentRelease();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer secret-token");

    vi.stubEnv("AGENT_RELEASES_URL", "http://127.0.0.1:8080/repos/ReSpOnSeSC2/sc2tools/releases");
    answer([]);
    await fetchLatestAgentRelease();
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:8080/repos/ReSpOnSeSC2/sc2tools/releases");
    expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty("Authorization");
  });

  it.each([
    ["an error status", () => answer({ message: "API rate limit exceeded" }, 403), /github releases fetch 403/],
    ["a body that isn't a list", () => answer({ message: "Moved" }), /not a list/],
    ["a network failure", () => fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")), /fetch failed/],
  ])("throws on %s", async (_case, arrange, reason) => {
    arrange();
    await expect(fetchLatestAgentRelease()).rejects.toThrow(reason);
  });

  // Next drops a fetch's signal when it refreshes a stale cache entry, so a
  // stalled GitHub must be cut off by the lookup itself.
  it.each([
    ["the request ignores its abort signal", () => fetchMock.mockImplementation(() => new Promise(() => {}))],
    ["the body never arrives", () => fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) })],
  ])("gives up after 10 seconds when %s", async (_case, arrange) => {
    vi.useFakeTimers();
    try {
      arrange();
      let settled = false;
      const outcome = fetchLatestAgentRelease().finally(() => { settled = true; });
      const rejected = expect(outcome).rejects.toThrow("github releases fetch timed out after 10000 ms");
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("latestPublishedAgentVersion", () => {
  it("names the newest published version without the tag prefix", async () => {
    answer([release("agent-v0.25.7"), release("agent-v0.25.8"), release("agent-v0.25.9", { draft: true })]);
    expect(await latestPublishedAgentVersion()).toBe("0.25.8");
  });

  it("is null when GitHub lists no published agent release", async () => {
    answer([]);
    expect(await latestPublishedAgentVersion()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["in tests", "test", ""],
    ["in development", "development", "phase-development-server"],
    ["while building for production", "production", "phase-production-build"],
  ])("falls back (null) when GitHub can't be read %s", async (_case, nodeEnv, phase) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("NEXT_PHASE", phase);
    answer({ message: "API rate limit exceeded" }, 403);
    expect(await latestPublishedAgentVersion()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("(github releases fetch 403)");
  });

  it("names a network failure's code in the one-line warning", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
    expect(await latestPublishedAgentVersion()).toBeNull();
    expect(warn.mock.calls[0][0]).toContain("(fetch failed: ECONNREFUSED)");
  });

  it("throws a handled error on a production server so Next keeps the last good page", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    answer({ message: "API rate limit exceeded" }, 403);
    const failure = await latestPublishedAgentVersion().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentReleasesUnavailableError);
    expect(failure).toMatchObject({ name: AGENT_RELEASES_UNAVAILABLE, message: expect.stringContaining("(github releases fetch 403)") });
    expect((failure as Error).cause).toEqual(new Error("github releases fetch 403"));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("compareAgentVersions", () => {
  it("orders by number, ignores suffixes and sorts unparseable text first", () => {
    expect(compareAgentVersions("0.3.11", "0.3.4")).toBeGreaterThan(0);
    expect(compareAgentVersions("0.25.8", "1.0.0")).toBeLessThan(0);
    expect(compareAgentVersions("0.25.8+build.2", "0.25.8")).toBe(0);
    expect(compareAgentVersions("next", "0.0.1")).toBeLessThan(0);
  });
});

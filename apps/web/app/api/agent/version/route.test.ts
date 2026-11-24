import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, revalidate } from "./route";
import { AGENT_RELEASES_REVALIDATE_SECONDS } from "@/lib/agentReleaseSource.server";

const SHA = "ab".repeat(32);
const fetchMock = vi.fn();
const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
afterAll(() => consoleError.mockRestore());

function release(version: string, extra: Record<string, unknown> = {}) {
  const installer = `SC2ToolsAgent-Setup-${version}.exe`;
  return {
    tag_name: `agent-v${version}`,
    draft: false,
    prerelease: false,
    published_at: "2026-11-24T17:53:30Z",
    body: `Notes for ${version}`,
    assets: [
      { name: installer, browser_download_url: `https://github.com/download/${installer}`, size: 42 },
      { name: `${installer}.sha256`, browser_download_url: `https://github.com/download/${installer}.sha256`, size: 64 },
    ],
    ...extra,
  };
}

function githubAnswers(releases: unknown[]) {
  fetchMock.mockImplementation(async (url: string) => (url.endsWith(".sha256")
    ? new Response(`${SHA}  installer.exe\n`)
    : new Response(JSON.stringify(releases))));
}

function get(query: string) {
  return GET(new NextRequest(`https://sc2tools.test/api/agent/version?${query}`));
}

beforeEach(() => {
  fetchMock.mockReset();
  consoleError.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/agent/version", () => {
  it("offers the newest published agent release with its installer and checksum", async () => {
    githubAnswers([release("0.25.7"), release("0.25.8"), release("0.25.9", { draft: true })]);
    const response = await get("channel=stable&platform=windows&current=0.25.7");
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=600, stale-while-revalidate=86400");
    expect(await response.json()).toEqual({
      ok: true,
      channel: "stable",
      platform: "windows",
      update_available: true,
      current: "0.25.7",
      latest: "0.25.8",
      publishedAt: "2026-11-24T17:53:30Z",
      releaseNotes: "Notes for 0.25.8",
      minSupportedVersion: null,
      artifact: {
        platform: "windows",
        downloadUrl: "https://github.com/download/SC2ToolsAgent-Setup-0.25.8.exe",
        sha256: SHA,
        sizeBytes: 42,
        signature: null,
      },
    });
  });

  it("names the release without an artifact for other platforms and reports no update when current", async () => {
    githubAnswers([release("0.25.8")]);
    const body = await (await get("platform=mac&current=0.25.8")).json();
    expect(body).toMatchObject({ latest: "0.25.8", update_available: false, platform: "mac" });
    expect(body).not.toHaveProperty("artifact");
  });

  it("answers without a version, uncached, when GitHub can't be read", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));
    const response = await get("current=0.25.7");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, update_available: false, current: "0.25.7" });
    expect(body).not.toHaveProperty("latest");
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("caches on the release lookup's period", () => {
    expect(revalidate).toBe(AGENT_RELEASES_REVALIDATE_SECONDS);
  });
});

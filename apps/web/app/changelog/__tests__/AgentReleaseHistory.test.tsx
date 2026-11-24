import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dynamic, revalidate } from "@/app/changelog/page";
import { AgentReleaseHistory } from "@/app/changelog/AgentReleaseHistory";
import { FALLBACK_LATEST_AGENT_VERSION } from "@/lib/agentNotice";
import { AGENT_RELEASES_REVALIDATE_SECONDS } from "@/lib/agentReleaseSource.server";
import { readAgentChangelog } from "@/lib/agentReleases";

const fetchMock = vi.fn();
const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => warn.mockRestore());

function githubPublishes(version: string) {
  const body = JSON.stringify([{
    tag_name: `agent-v${version}`,
    draft: false,
    prerelease: false,
    assets: [{ name: `SC2ToolsAgent-Setup-${version}.exe`, browser_download_url: "https://example.test/setup.exe", size: 1 }],
  }]);
  fetchMock.mockImplementation(async () => new Response(body));
}

/** One <details> per release, newest first (release notes hold lists of their own). */
async function renderHistory() {
  render(await AgentReleaseHistory());
  const history = screen.getByRole("region", { name: "Agent release notes" });
  return [...history.querySelectorAll<HTMLDetailsElement>("ol > li > details")];
}

beforeEach(() => {
  fetchMock.mockReset();
  warn.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("changelog Agent release notes", () => {
  it("opens on the newest release GitHub has published and leaves out one still being prepared", async () => {
    const [newest, published] = readAgentChangelog().map(({ version }) => version);
    githubPublishes(published);
    const [latest, older] = await renderHistory();
    expect(latest.querySelector("summary")?.textContent).toContain(`Agent ${published}`);
    expect(latest.hasAttribute("open")).toBe(true);
    expect(older.hasAttribute("open")).toBe(false);
    expect(screen.queryByText(`Agent ${newest}`, { exact: false })).toBeNull();
  });

  it("shows a release as soon as GitHub lists it as published", async () => {
    const [newest] = readAgentChangelog().map(({ version }) => version);
    githubPublishes(newest);
    const [latest] = await renderHistory();
    expect(latest.querySelector("summary")?.textContent).toContain(`Agent ${newest}`);
    expect(latest.querySelector(`[id="agent-v${newest}"]`)).not.toBeNull();
  });

  it("opens on the build's fallback version when GitHub can't be read", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const [latest] = await renderHistory();
    expect(latest.querySelector("summary")?.textContent).toContain(`Agent ${FALLBACK_LATEST_AGENT_VERSION}`);
  });

  it("renders the page statically and again every 10 minutes", () => {
    expect(dynamic).toBe("force-static");
    expect(revalidate).toBe(AGENT_RELEASES_REVALIDATE_SECONDS);
  });
});

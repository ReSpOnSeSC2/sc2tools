import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, dynamic, revalidate } from "@/app/changelog/agent.xml/route";
import { GET as productFeed } from "@/app/changelog/rss.xml/route";
import { FALLBACK_LATEST_AGENT_VERSION } from "../agentNotice";
import { AGENT_RELEASES_REVALIDATE_SECONDS } from "../agentReleaseSource.server";
import {
  agentReleaseAnchor,
  agentReleaseMarkdown,
  getAgentReleaseNotes,
  parseAgentChangelog,
  publishedAgentReleases,
  readAgentChangelog,
  type AgentRelease,
} from "../agentReleases";
import { rssResponse } from "../rss";
import nextConfig from "../../next.config.mjs";

/** The matcher Next applies to outputFileTracingIncludes keys (build/collect-build-traces.js). */
const picomatch = createRequire(import.meta.url)("next/dist/compiled/picomatch") as (
  glob: string,
  options: { dot: boolean; contains: boolean },
) => (route: string) => boolean;

const fetchMock = vi.fn();
const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => warn.mockRestore());

/** GitHub's release list with `versions` published, each with its installer. */
function githubPublishes(...versions: string[]) {
  const body = JSON.stringify(versions.map(version => ({
    tag_name: `agent-v${version}`,
    draft: false,
    prerelease: false,
    assets: [{ name: `SC2ToolsAgent-Setup-${version}.exe`, browser_download_url: "https://example.test/setup.exe", size: 1 }],
  })));
  fetchMock.mockImplementation(async () => new Response(body));
}

function releases(...versions: string[]): AgentRelease[] {
  return versions.map(version => ({ version, notes: `- Notes for ${version}` }));
}

const versionsOf = (list: AgentRelease[]) => list.map(({ version }) => version);

beforeEach(() => {
  fetchMock.mockReset();
  warn.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Agent release history", () => {
  it("preserves version order, optional dates and Markdown from Windows checkouts", () => {
    const changelog = "# Changelog\r\n\r\n## 0.24.11\r\n\r\n### Added\r\n- New note\r\n## 0.24.9 - 2026-11-02\r\n- Older note\r\n";
    expect(parseAgentChangelog(changelog)).toEqual([
      { version: "0.24.11", date: undefined, notes: "### Added\n- New note" },
      { version: "0.24.9", date: "2026-11-02", notes: "- Older note" },
    ]);
  });

  it("omits a single leading Unreleased section while keeping published notes", () => {
    const changelog = "# Changelog\r\n\r\n## [Unreleased]\r\n### Added\r\n- Draft note\r\n\r\n## 0.25.1\r\n- Published note\r\n";
    expect(parseAgentChangelog(changelog)).toEqual([
      { version: "0.25.1", date: undefined, notes: "- Published note" },
    ]);
  });

  it.each([
    ["# Changelog\nNo versions", /no version sections/],
    ["# Changelog\n## [Unreleased]\n- Draft note", /no version sections/],
    ["## [Unreleased]\n- Draft\n## [Unreleased]\n- Duplicate\n## 0.25.1\n- Note", /Invalid Agent release heading/],
    ["## 0.25.1\n- Note\n## [Unreleased]\n- Late draft", /Invalid Agent release heading/],
    ["## [Unreleased] - 2026-11-12\n- Draft\n## 0.25.1\n- Note", /Invalid Agent release heading/],
    ["## 0.24.11\n- Note\n## 0.24.next\n- Note", /Invalid Agent release heading/],
    ["## 0.24.11 - 2026-02-30\n- Note", /Invalid date/],
    ["## 0.24.11\n\n## 0.24.9\n- Note", /Missing release notes/],
    ["## [Unreleased]\n- Draft\n## 0.24.9\n- Note\n## 0.24.11\n- Note", /newest first/],
    ["## [Unreleased]\n- Draft\n## 0.24.9\n- Note\n## 0.24.9\n- Repeat", /unique/],
  ] as const)("fails on invalid release content %s", (markdown, reason) => {
    expect(() => parseAgentChangelog(markdown)).toThrow(reason);
  });

  it("links the release's committed gallery and leaves unrelated relative links alone", () => {
    const source = readFileSync(resolve(process.cwd(), "../agent/CHANGELOG.md"), "utf8");
    const notes = parseAgentChangelog(source).find(({ version }) => version === "0.25.0")?.notes ?? "";
    const gallery = "docs/images/agent-0.25.0/interface-gallery/README.md";
    expect(agentReleaseMarkdown("0.25.0", notes)).toContain(
      `[interface gallery](https://github.com/ReSpOnSeSC2/sc2tools/blob/main/${gallery})`,
    );
    const unrelated = "[internal](../../private/notes.md)";
    expect(agentReleaseMarkdown("0.25.0", unrelated)).toBe(unrelated);
  });
});

describe("published Agent releases", () => {
  it("starts at the newest published release and hides a version still being prepared", () => {
    expect(versionsOf(publishedAgentReleases(releases("0.25.9", "0.25.8", "0.25.7"), "0.25.8"))).toEqual(["0.25.8", "0.25.7"]);
  });

  it("starts at the newest entry when GitHub names a release this build has no notes for yet", () => {
    expect(versionsOf(publishedAgentReleases(releases("0.25.8", "0.25.7"), "0.25.9"))).toEqual(["0.25.8", "0.25.7"]);
    expect(versionsOf(publishedAgentReleases(releases("0.25.10", "0.25.8", "0.25.7"), "0.25.9"))).toEqual(["0.25.8", "0.25.7"]);
  });

  it("starts at the build's fallback version without an answer from GitHub", () => {
    const changelog = releases("99.0.0", FALLBACK_LATEST_AGENT_VERSION, "0.0.1");
    expect(versionsOf(publishedAgentReleases(changelog, null))).toEqual([FALLBACK_LATEST_AGENT_VERSION, "0.0.1"]);
  });

  it("fails when no entry is old enough to have been published", () => {
    expect(() => publishedAgentReleases(releases("0.25.8", "0.25.7"), "0.25.6")).toThrow(/No Agent changelog entry at or below 0.25.6/);
  });

  it("names the build's fallback version in the agent changelog", () => {
    expect(versionsOf(readAgentChangelog())).toContain(FALLBACK_LATEST_AGENT_VERSION);
  });

  // Without the file in their server bundle, every regeneration would fail and
  // the page would silently stay on its build-time list.
  it("traces the agent changelog into both routes that read it when they render", () => {
    const includes: Record<string, string[]> = nextConfig.outputFileTracingIncludes ?? {};
    const changelog = resolve(process.cwd(), "../agent/CHANGELOG.md");
    expect(existsSync(changelog)).toBe(true);
    for (const route of ["/changelog", "/changelog/agent.xml"]) {
      const traced = Object.entries(includes)
        .filter(([glob]) => picomatch(glob, { dot: true, contains: true })(route))
        .flatMap(([, files]) => files.map(file => resolve(process.cwd(), file)));
      expect(traced, route).toContain(changelog);
    }
  });

  it("follows GitHub's newest published release through the real changelog", async () => {
    const [newest, previous] = versionsOf(readAgentChangelog());
    githubPublishes(previous);
    expect((await getAgentReleaseNotes())[0].version).toBe(previous);
    githubPublishes(previous, newest);
    expect((await getAgentReleaseNotes())[0].version).toBe(newest);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the build's version when GitHub can't be read", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect((await getAgentReleaseNotes())[0].version).toBe(FALLBACK_LATEST_AGENT_VERSION);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("Agent RSS feed", () => {
  it("publishes valid RSS with a stable page link for every published version", async () => {
    const [newest, previous] = versionsOf(readAgentChangelog());
    githubPublishes(previous);
    const included = publishedAgentReleases(readAgentChangelog(), previous);
    const response = await GET();
    const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
    const items = [...xml.querySelectorAll("item")];

    expect(response.headers.get("Content-Type")).toContain("application/rss+xml");
    expect(xml.querySelector("parsererror")).toBeNull();
    expect(xml.documentElement.getAttribute("version")).toBe("2.0");
    expect(items).toHaveLength(included.length);
    expect(items.map(item => item.querySelector("title")?.textContent)).toEqual(included.map(({ version }) => `SC2 Tools Agent ${version}`));
    expect(items.map(item => item.querySelector("guid")?.textContent?.split("#")[1])).toEqual(included.map(({ version }) => agentReleaseAnchor(version)));
    expect(items.map(item => Boolean(item.querySelector("pubDate")))).toEqual(included.map(({ date }) => Boolean(date)));
    expect(items.some(item => item.querySelector("guid")?.textContent?.endsWith(`#${agentReleaseAnchor(newest)}`))).toBe(false);
  });

  it("renders statically and again every 10 minutes, like the release lookup", () => {
    expect(dynamic).toBe("force-static");
    expect(revalidate).toBe(AGENT_RELEASES_REVALIDATE_SECONDS);
  });

  it("only emits announcement entries in the product feed", async () => {
    const xml = new DOMParser().parseFromString(await productFeed().text(), "application/xml");
    const items = [...xml.querySelectorAll("item")];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(item => !item.querySelector("guid")?.textContent?.includes("#agent-v"))).toBe(true);
    expect(items.some(item => item.querySelector("guid")?.textContent?.endsWith("#personal-notifications-and-replies"))).toBe(true);
  });

  it("escapes text and serializes only dates that were supplied", async () => {
    const notes = `Use "A & B" < 10, then select 'Done'.`;
    const response = rssResponse("Agent & tools", "Updates", "/changelog", [
      { path: "/changelog#latest", title: "Latest", description: notes },
      { path: "/changelog#older", title: "Older", description: "Fixes", date: "2026-10-23" },
    ]);
    const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
    const [latest, older] = xml.querySelectorAll("item");
    expect(xml.querySelector("parsererror")).toBeNull();
    expect(xml.querySelector("channel > title")?.textContent).toBe("Agent & tools");
    expect(latest.querySelector("description")?.textContent).toBe(notes);
    expect(latest.querySelector("pubDate")).toBeNull();
    expect(older.querySelector("pubDate")?.textContent).toBe("Fri, 23 Oct 2026 00:00:00 GMT");
  });
});

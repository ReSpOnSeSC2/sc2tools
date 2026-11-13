import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GET, dynamic } from "@/app/changelog/agent.xml/route";
import { GET as productFeed } from "@/app/changelog/rss.xml/route";
import { FALLBACK_LATEST_AGENT_VERSION } from "../agentNotice";
import { agentReleaseAnchor, agentReleaseMarkdown, getAgentReleaseNotes, parseAgentChangelog } from "../agentReleases";
import { rssResponse } from "../rss";

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

  it("reads the real changelog with the tracked published version first", () => {
    const releases = getAgentReleaseNotes();
    expect(releases.length).toBeGreaterThan(1);
    expect(releases[0].version).toBe(FALLBACK_LATEST_AGENT_VERSION);
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

  it("publishes valid static RSS with a stable page link for every included version", async () => {
    const releases = getAgentReleaseNotes();
    const response = GET();
    const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
    const items = [...xml.querySelectorAll("item")];

    expect(dynamic).toBe("force-static");
    expect(response.headers.get("Content-Type")).toContain("application/rss+xml");
    expect(xml.querySelector("parsererror")).toBeNull();
    expect(xml.documentElement.getAttribute("version")).toBe("2.0");
    expect(items).toHaveLength(releases.length);
    expect(items.map(item => item.querySelector("title")?.textContent)).toEqual(releases.map(({ version }) => `SC2 Tools Agent ${version}`));
    expect(items.map(item => item.querySelector("guid")?.textContent?.split("#")[1])).toEqual(releases.map(({ version }) => agentReleaseAnchor(version)));
    expect(items.map(item => Boolean(item.querySelector("pubDate")))).toEqual(releases.map(({ date }) => Boolean(date)));
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

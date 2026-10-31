import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getArticle } from "../index";

// Keep identical to apps/agent/sc2tools_agent/ui/help_links.py.
const AGENT_HELP_SLUGS = [
  "desktop-app-overview", "desktop-app-sync-range", "replay-folders",
  "obs-auto-scene-switching", "build-check-in", "desktop-app-activity-log",
  "pairing-troubleshooting", "desktop-app-sync-problems",
  "desktop-app-tray", "desktop-app-performance", "desktop-app-updates", "desktop-app-status",
  "desktop-app-import",
];

describe("desktop agent help links", () => {
  it("resolves every native help button to a published article", () => {
    for (const slug of AGENT_HELP_SLUGS) expect(getArticle(slug), slug).toBeTruthy();
  });
  it("stays aligned with the desktop destinations", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../agent/sc2tools_agent/ui/help_links.py"), "utf8");
    const tuple = source.match(/AGENT_HELP_SLUGS\s*=\s*\(([\s\S]*?)\)/)?.[1] ?? "";
    expect([...tuple.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1])).toEqual(AGENT_HELP_SLUGS);
  });
});

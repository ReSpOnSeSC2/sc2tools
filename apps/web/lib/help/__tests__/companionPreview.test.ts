import { describe, expect, it } from "vitest";
import { getArticle } from "../index";
import { helpBlockText } from "../articleText";

describe("Companion release documentation", () => {
  it("points to the current Agent update flow rather than obsolete test previews", () => {
    for (const slug of ["desktop-companion", "install-app", "randomizer", "practice-ghost-build", "build-check-in", "desktop-app-overview"]) {
      const article = getArticle(slug);
      expect(article, slug).toBeDefined();
      const text = article!.body.map(helpBlockText).join(" ");
      expect(text, slug).toContain(slug === "desktop-companion" ? "0.24.2" : "0.24.1");
      expect(text, slug).not.toContain("verification preview");
      expect(text, slug).not.toContain("not included in the current stable download");
    }
    for (const slug of ["desktop-companion", "install-app"]) {
      const first = getArticle(slug)!.body[0];
      expect(first.type).toBe("callout");
      expect(helpBlockText(first)).toContain("Check for updates");
    }
  });

  it("documents the small layouts, themed controls and stored replay ranges", () => {
    const text = getArticle("desktop-companion")!.body.map(helpBlockText).join(" ");
    for (const phrase of ["420 × 44", "transparent", "race-themed", "520 × 680", "1024 × 800", "minimize", "close", "3 minutes", "6 minutes", "10 minutes", "Full build order", "Scouting preview", "repeated production", "Default", "Protoss", "Terran", "Zerg", "animations off"]) {
      expect(text).toContain(phrase);
    }
  });

  it("documents confirmed Hybrid team scope, gradual legacy metadata and illustrated native tools", () => {
    const article = getArticle("desktop-companion")!;
    const text = article.body.map(helpBlockText).join(" ");
    for (const phrase of ["Hybrid team scouting", "Enemy roster", "Right-click Compact", "authoritative team IDs",
      "explicitly identify your own player", "Historical 1v1 MMR", "not current team-ladder rating",
      "randomizer draws are 1v1-only", "Use this target in current team game",
      "does not overwrite a saved 1v1 target", "without resyncing", "actual played date",
      "unpairing discard in-flight metadata replies", "credential-bearing third-party connection logs"]) {
      expect(text).toContain(phrase);
    }
    for (const source of ["/landing/companion-race-skins.png", "/landing/companion-postgame.png", "/landing/companion-randomizer.png", "/landing/companion-team-hybrid.png"]) {
      expect(article.body.some(block => block.type === "image" && block.src === source)).toBe(true);
    }
    expect(text).not.toContain("Actual team-game guidance is unsupported");
  });

  it("explains Session opt-in, source limits and game-only click-through without changing close behavior", () => {
    const text = getArticle("desktop-companion")!.body.map(helpBlockText).join(" ");
    for (const phrase of ["Keep session record on top", "Assistance → Connect Session stats…", "confirmation defaults to", "off by default", "four-hour-inactivity",
      "not a calendar-day total", "explicitly confirm before creating access", "never create or recreate credentials automatically",
      "own latest-known MMR", "rating region", "Active server detection is unavailable", "em dash, not zero",
      "90 seconds", "In-game assistance off hides Session without resetting", "stop its Session connection",
      "StarCraft II is the verified foreground application", "Alt+Tab away", "Standard stays interactive",
      "X", "without switching off your already enabled pinned panels", "does not change minimize or close behavior"]) {
      expect(text).toContain(phrase);
    }
    expect(text).not.toContain("automatically creates an overlay token");
    const gallery = getArticle("desktop-companion")!.body.find(block => block.type === "image" && block.src === "/landing/companion-session.png");
    expect(gallery?.type).toBe("image");
    if (gallery?.type === "image") {
      expect(gallery.alt).toContain("sample session record");
      expect(gallery.caption).toContain("150 × 138");
      expect(gallery.caption).toContain("sample data");
      expect(gallery.caption).toContain("not a verified active server");
    }
  });

  it("documents explicit check-in selection and widget-only playback", () => {
    for (const slug of ["desktop-companion", "randomizer", "build-check-in", "install-app"]) {
      const text = getArticle(slug)!.body.map(helpBlockText).join(" ");
      expect(text, slug).toContain("widget");
      expect(text, slug).not.toContain("standalone randomizer");
      expect(text, slug).not.toContain("native randomizer waits");
      expect(text, slug).not.toContain("native Companion roll suppresses");
      expect(text, slug).toContain("Randomize");
      expect(text, slug).toContain("without an open widget");
      expect(text, slug).not.toContain("Roll in widget");
    }
    const article = getArticle("desktop-companion")!;
    const text = article.body.map(helpBlockText).join(" ");
    for (const phrase of ["animation, sounds and spoken results are widget-only", "no native current-game Randomizer window",
      "saved result is read-only", "reuse the same saved result", "failure shows a message and allows retry",
      "Native scouting voice is unaffected by widget-only Randomizer playback"]) {
      expect(text).toContain(phrase);
    }
    const settings = article.body.find(block => block.type === "image" && block.src === "/landing/companion-randomizer.png");
    expect(settings?.type).toBe("image");
    if (settings?.type === "image") {
      expect(settings.alt).toContain("without a native roll control");
      expect(settings.caption).toContain("900 × 480");
      expect(settings.caption).toContain("sample data");
      expect(settings.caption).toContain("not a native live-draw popup");
    }
  });

  it("documents each player's last five games, what a first meeting shows and the version that brings them", () => {
    const article = getArticle("desktop-companion")!;
    const start = article.body.findIndex(block => block.type === "heading" && block.anchor === "last-five-games");
    expect(start).toBeGreaterThan(-1);
    const end = article.body.findIndex((block, index) => index > start && block.type === "heading");
    const section = article.body.slice(start, end);
    const text = section.map(helpBlockText).join(" ");
    for (const phrase of ["previous five games, newest first", "your result in that game", "your last five games in this matchup",
      "in your library against this player", "linked accounts", "another race", "2 EARLIER GAMES", "FIRST MEETING", "NOT IDENTIFIED YET",
      "never a guess", "knows a build only from a game you played", "Keep scouting closed on a first meeting",
      "on by default", "Scouting button still opens it", "short form"]) {
      expect(text).toContain(phrase);
    }
    // The site goes live before the agent release does: the section says which
    // version brings the lists and never tells a player to install it now.
    expect(section[1].type).toBe("callout");
    expect(helpBlockText(section[1])).toContain("arrive with agent 0.25.0");
    expect(text).not.toMatch(/Check for updates|download/i);
    const picture = section.find(block => block.type === "image");
    expect(picture?.type).toBe("image");
    if (picture?.type === "image") {
      expect(picture.src).toBe("/landing/companion-last-five-games.png");
      expect(picture.caption).toContain("sample data");
      expect(picture.caption).toContain("650 × 450");
    }
    const strip = getArticle("desktop-scouting")!.body.map(helpBlockText).join(" ");
    expect(strip).toContain("Their last 5 games");
    expect(strip).toContain("arrive with agent 0.25.0");
    expect(strip).toContain("a first meeting has none");
    expect(strip).toContain("all five games fit");
  });
});

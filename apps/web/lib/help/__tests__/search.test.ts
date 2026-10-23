import { describe, expect, it } from "vitest";
import {
  HELP_FIELD_WEIGHTS,
  HELP_SYNONYMS,
  buildHelpSearchIndex,
  helpSearchTokens,
  searchHelp,
  withinOneEdit,
} from "../search";
import type { HelpArticle } from "../types";

const slugs = (query: string) => searchHelp(query).map((result) => result.article.slug);
const top = (query: string) => slugs(query)[0];

function fixture(slug: string, fields: Partial<HelpArticle>): HelpArticle {
  return {
    slug,
    title: `Article ${slug}`,
    summary: "Plain summary.",
    category: "troubleshooting",
    audience: "all",
    keywords: ["filler"],
    updated: "2026-10-22",
    body: [{ type: "paragraph", text: "Plain body." }],
    related: [],
    ...fields,
  };
}

describe("helpSearchTokens", () => {
  it("lowercases, strips accents and apostrophes, and drops one-letter tokens", () => {
    expect(helpSearchTokens("What's the 6-digit Côde?")).toEqual(["whats", "the", "digit", "code"]);
  });

  it("also counts a hyphenated word as one word", () => {
    expect(helpSearchTokens("Build check-in")).toEqual(["build", "check", "in", "checkin"]);
    expect(helpSearchTokens("6-digit")).toEqual(["digit"]);
  });

  it("keeps chat commands as their own words", () => {
    expect(helpSearchTokens("Type !win or !1 / !2, wow!")).toEqual(["type", "!win", "or", "!1", "!2", "wow"]);
  });
});

describe("withinOneEdit", () => {
  it("allows one substitution, insertion or deletion", () => {
    expect(withinOneEdit("expired", "expires")).toBe(true);
    expect(withinOneEdit("overlay", "ovrlay")).toBe(true);
    expect(withinOneEdit("build", "builds")).toBe(true);
    expect(withinOneEdit("overlay", "ovelray")).toBe(false);
    expect(withinOneEdit("pairing", "pair")).toBe(false);
  });
});

describe("searchHelp on the shipped articles", () => {
  it("ranks the pairing walkthrough first for 'code expired'", () => {
    expect(top("code expired")).toBe("install-and-pair");
    expect(top("pairing code")).toBe("install-and-pair");
    expect(slugs("pairing code")).toContain("getting-started");
  });

  it("finds articles by title words, keywords and prefixes", () => {
    expect(top("build check-in")).toBe("build-check-in");
    expect(top("browser source")).toBe("obs-overlay-setup");
    expect(top("pair")).toBe("pairing-troubleshooting");
    expect(top("tikt")).toBe("multi-platform-chat");
    expect(top("stream dock")).toBe("stream-dock");
    expect(top("!rank")).toBe("viewer-engagement");
    expect(slugs("!win")).toEqual(["viewer-engagement"]);
  });

  it("finds hyphenated features typed as one word", () => {
    expect(top("checkin")).toBe("build-check-in");
    expect(top("checkins")).toBe("build-check-in");
    expect(top("translate")).toBe("multi-platform-chat");
  });

  it("tolerates one typo in longer words, not in short ones", () => {
    expect(top("ovrlay setup")).toBe("obs-overlay-setup");
    expect(top("randomiser")).toBe("randomizer");
    expect(slugs("kikc")).toEqual([]);
  });

  it("expands the short forms readers type", () => {
    expect(HELP_SYNONYMS).toMatchObject({
      obs: ["overlay"],
      code: ["pairing"],
      tray: ["desktop app"],
      sync: ["upload"],
    });
    expect(top("obs")).toBe("obs-overlay-setup");
    expect(slugs("tray")).toContain("getting-started");
    expect(slugs("tray")).toContain("desktop-app-overview");
    expect(slugs("sync")).toContain("desktop-app-overview");
    expect(slugs("sync")).toContain("my-game-didnt-show-up");
  });

  it("ignores filler words unless they are all there is", () => {
    expect(slugs("how do I set up the overlay")).toEqual(slugs("set up overlay"));
    expect(searchHelp("")).toEqual([]);
    expect(searchHelp("   ")).toEqual([]);
  });

  it("is deterministic and honours the limit", () => {
    expect(searchHelp("chat")).toEqual(searchHelp("chat"));
    expect(searchHelp("the", { limit: 2 }).length).toBeLessThanOrEqual(2);
  });
});

describe("searchHelp scoring", () => {
  const articles = [
    fixture("in-title", { title: "Replay folder" }),
    fixture("in-keywords", { keywords: ["replay"] }),
    fixture("in-summary", { summary: "Where the replay goes." }),
    fixture("in-body", { body: [{ type: "list", items: ["Your **replay** list"] }] }),
  ];
  const index = buildHelpSearchIndex(articles);

  it("weights title over keywords over summary over body", () => {
    expect(HELP_FIELD_WEIGHTS).toEqual({ title: 5, keywords: 4, summary: 2, body: 1 });
    expect(searchHelp("replay", { index }).map((result) => result.article.slug)).toEqual([
      "in-title",
      "in-keywords",
      "in-summary",
      "in-body",
    ]);
  });

  it("prefers articles that match every query word", () => {
    const both = fixture("both", { body: [{ type: "paragraph", text: "folder and replay" }] });
    const one = fixture("one", { title: "Folder folder" });
    const results = searchHelp("replay folder", { index: buildHelpSearchIndex([one, both]) });
    expect(results[0].article.slug).toBe("both");
  });

  it("breaks ties by title", () => {
    const tied = buildHelpSearchIndex([
      fixture("b", { title: "Beta", body: [{ type: "paragraph", text: "kick" }] }),
      fixture("a", { title: "Alpha", body: [{ type: "paragraph", text: "kick" }] }),
    ]);
    expect(searchHelp("kick", { index: tied }).map((result) => result.article.slug)).toEqual(["a", "b"]);
  });
});

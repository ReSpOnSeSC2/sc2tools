// @ts-nocheck
"use strict";

/**
 * services/guideVideoFeed.js (bounded Atom parser) and
 * services/guideVideoText.js (excerpt, checklist, public Video shape)
 * against a trimmed copy of the channel's real RSS feed
 * (__tests__/fixtures/guides/youtube-channel-feed.xml: a stream VOD, a
 * #Shorts clip, a Short YouTube only marks by its /shorts/ link, and
 * three long-form guides) plus hostile inputs.
 */

const fs = require("fs");
const path = require("path");
const {
  FEED_MAX_CHARS,
  FEED_MAX_ENTRIES,
  decodeXmlEntities,
  parseChannelFeed,
} = require("../src/services/guideVideoFeed");
const {
  extractExcerpt,
  extractChecklist,
  toPublicVideo,
} = require("../src/services/guideVideoText");

const FEED = fs.readFileSync(path.join(__dirname, "fixtures", "guides", "youtube-channel-feed.xml"), "utf8");
const CHANNEL = "UCZS3YP1mvpqyuU5vPvHVG7g";

/** @param {string} id @param {object} [o] */
function entry(id, o = {}) {
  const title = o.title === undefined ? `Title ${id}` : o.title;
  const published = o.published === undefined ? "2026-09-01T10:00:00+00:00" : o.published;
  return `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${o.channel || CHANNEL}</yt:channelId>`
    + `<title>${title}</title><link rel="alternate" href="${o.href || `https://www.youtube.com/watch?v=${id}`}"/>`
    + `<published>${published}</published><media:group><media:description>${o.description || ""}</media:description>`
    + "</media:group></entry>";
}

/** @param {string} body */
const feed = (body) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${body}</feed>`;

describe("parseChannelFeed on the real feed fixture", () => {
  const videos = parseChannelFeed(FEED);

  test("reads every entry in feed order with ids, times and channel", () => {
    expect(videos.map((v) => v.youtubeId)).toEqual([
      "fbLtIesBF8M", "BknmAh0ug6Q", "_U1MPQB_Q90", "1WX_FQ0nDqs", "AnmLN-xFtAc", "RYjRs_no8t4",
    ]);
    expect(videos[0]).toEqual({
      youtubeId: "fbLtIesBF8M",
      title: "GM Protoss TRYING TO IMPROVE",
      description: "Support the stream: https://streamlabs.com/responsesc2",
      publishedAt: "2026-09-27T14:36:37.000Z",
      channelId: CHANNEL,
      isShort: false,
    });
    for (const v of videos) expect(v.channelId).toBe(CHANNEL);
  });

  test("marks Shorts from YouTube's /shorts/ link", () => {
    const shorts = videos.filter((v) => v.isShort).map((v) => v.youtubeId);
    expect(shorts).toEqual(["BknmAh0ug6Q", "1WX_FQ0nDqs"]);
  });

  test("decodes XML entities in titles and descriptions", () => {
    const short = videos.find((v) => v.youtubeId === "BknmAh0ug6Q");
    expect(short.description).toContain("\"New Direction\" Kevin MacLeod");
    expect(short.description).toContain("index.html?Search=Search&isrc=");
    expect(short.description).not.toContain("&amp;");
    const alpha = videos.find((v) => v.youtubeId === "_U1MPQB_Q90");
    expect(alpha.title).toBe("I Tried AlphaStar's PvT Build — Can a Human Make It Work?");
  });
});

describe("parseChannelFeed bounds and malformed input", () => {
  test("non-strings, empty, oversize and garbage yield []", () => {
    expect(parseChannelFeed(undefined)).toEqual([]);
    expect(parseChannelFeed(42)).toEqual([]);
    expect(parseChannelFeed("")).toEqual([]);
    expect(parseChannelFeed("<html>consent page</html>")).toEqual([]);
    expect(parseChannelFeed(`${FEED}${" ".repeat(FEED_MAX_CHARS)}`)).toEqual([]);
    expect(parseChannelFeed("<entry><yt:videoId>")).toEqual([]);
  });

  test("drops entries without a valid id, title or published time", () => {
    const xml = feed([
      entry("short-id"),
      entry("AAAAAAAAAAA", { title: "" }),
      entry("BBBBBBBBBBB", { published: "not a date" }),
      entry("CCCCCCCCCCC", { title: "x".repeat(301) }),
      entry("DDDDDDDDDDD"),
    ].join(""));
    expect(parseChannelFeed(xml).map((v) => v.youtubeId)).toEqual(["DDDDDDDDDDD"]);
  });

  test("keeps entries before an unclosed one and drops duplicates", () => {
    const xml = feed(`${entry("AAAAAAAAAAA")}${entry("AAAAAAAAAAA")}${entry("BBBBBBBBBBB")}<entry><yt:videoId>CCCCCCCCCCC`);
    expect(parseChannelFeed(xml).map((v) => v.youtubeId)).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
  });

  test(`reads at most ${FEED_MAX_ENTRIES} entries`, () => {
    const ids = Array.from({ length: 60 }, (_, i) => `vid${String(i).padStart(8, "0")}`);
    const out = parseChannelFeed(feed(ids.map((id) => entry(id)).join("")));
    expect(out).toHaveLength(FEED_MAX_ENTRIES);
    expect(out[0].youtubeId).toBe(ids[0]);
  });
});

describe("parseChannelFeed on hostile markup", () => {
  test("hostile near-cap feeds parse in linear time (no event-loop stall)", () => {
    // Unclosed tags used to make the per-tag lazy regexes re-scan to the end
    // of the block from every opening tag: ~1 MB of "<title>" took ~50 s and
    // ~1 MB of "<link " over 2 minutes. indexOf scanning keeps each input
    // to milliseconds; the budget below is two orders of magnitude of slack.
    const head = "<yt:videoId>AAAAAAAAAAA</yt:videoId><title>x</title><published>2026-01-01T00:00:00Z</published>";
    const hostile = {
      openTitles: `<entry>${"<title>".repeat(140000)}</entry>`,
      prefixTitles: `<entry>${"<titlex".repeat(140000)}</entry>`,
      openDescriptions: `<entry>${head}${"<media:description>".repeat(50000)}</entry>`,
      unterminatedLinks: `<entry>${head}${"<link ".repeat(170000)}</entry>`,
      manyLinks: `<entry>${head}${"<link rel=\"x\">".repeat(70000)}</entry>`,
    };
    const BUDGET_MS = 2000;
    for (const [label, body] of Object.entries(hostile)) {
      const xml = feed(body);
      expect(xml.length).toBeLessThanOrEqual(FEED_MAX_CHARS);
      const started = Date.now();
      const out = parseChannelFeed(xml);
      expect({ label, fast: Date.now() - started < BUDGET_MS }).toEqual({ label, fast: true });
      expect(out.length).toBeLessThanOrEqual(1);
    }
  });

  test("an element name must end at whitespace or '>' (\"<titles>\" is not <title>)", () => {
    const xml = feed(entry("AAAAAAAAAAA", { title: "Real title" }).replace("<title>", "<titles>nope</titles><title>"));
    expect(parseChannelFeed(xml)[0].title).toBe("Real title");
  });
});

describe("parseChannelFeed field decoding", () => {
  test("an invalid channel id is reported as null", () => {
    const [v] = parseChannelFeed(feed(entry("AAAAAAAAAAA", { channel: "not-a-channel" })));
    expect(v.channelId).toBeNull();
  });

  test("CDATA text is taken as written", () => {
    const [v] = parseChannelFeed(feed(entry("AAAAAAAAAAA", { title: "<![CDATA[PvZ & <b>more</b>]]>" })));
    expect(v.title).toBe("PvZ & <b>more</b>");
  });

  test("decodeXmlEntities handles named, numeric and invalid references", () => {
    expect(decodeXmlEntities("Q&amp;A &lt;b&gt; &quot;x&quot; &apos;y&apos;")).toBe("Q&A <b> \"x\" 'y'");
    expect(decodeXmlEntities("&#8212; &#x2014; &#X2014;")).toBe("— — —");
    expect(decodeXmlEntities("&#0; &#xD800; &#x110000; &nbsp; &bogus;")).toBe("&#0; &#xD800; &#x110000; &nbsp; &bogus;");
  });
});

describe("extractExcerpt", () => {
  test("is the first paragraph with whitespace collapsed", () => {
    expect(extractExcerpt("\n\n  First line\nsame   paragraph.\n\nSecond.")).toBe("First line same paragraph.");
    expect(extractExcerpt("Tab and nbsp")).toBe("Tab and nbsp");
    expect(extractExcerpt("")).toBe("");
    expect(extractExcerpt(null)).toBe("");
  });

  test("cuts a long paragraph at a word boundary within 300 chars", () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const out = extractExcerpt(words);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
    expect(words.startsWith(out.slice(0, -1))).toBe(true);
    expect(words[out.length - 1]).toBe(" ");
  });
});

describe("extractChecklist", () => {
  test("reads the first qualifying ALL-CAPS section up to the next blank line", () => {
    const text = "Intro.\n\nCHAPTERS\n0:00 Start\n\nBUILD CHECKLIST\n• 14 Gateway\n•   Stargate at 150 gas\n\nMore prose.";
    expect(extractChecklist(text)).toEqual(["14 Gateway", "Stargate at 150 gas"]);
  });

  test("skips decoration and leading blank lines; stops at the next header", () => {
    const text = "▬▬▬ THE 8-POOL RESPONSE ▬▬▬\n\n• 13 Gateway\n• Scout\nNEXT HEADER\n• not included";
    expect(extractChecklist(text)).toEqual(["13 Gateway", "Scout"]);
  });

  test("skips source headers and prose-length sections instead of truncating", () => {
    expect(extractChecklist("EVIDENCE NOTES\nSource: the replay.\n")).toBeNull();
    expect(extractChecklist("BUILD INSPIRATION\nI saw it from a friend.\n")).toBeNull();
    const prose = `BUILD NOTES\n${"x".repeat(161)}\n\nFULL BUILD ORDER\n12 Pylon\n`;
    expect(extractChecklist(prose)).toEqual(["12 Pylon"]);
  });

  test("caps a checklist at 20 lines and ignores headers without a keyword", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${i + 1} step`).join("\n");
    expect(extractChecklist(`FULL BUILD ORDER\n${lines}`)).toHaveLength(20);
    expect(extractChecklist("WHO THIS IS FOR\nPlatinum players\n")).toBeNull();
    expect(extractChecklist("Build notes\n• lower-case header\n")).toBeNull();
    expect(extractChecklist(undefined)).toBeNull();
  });
});

describe("toPublicVideo", () => {
  test("builds the public Video shape from a stored row", () => {
    const video = toPublicVideo({
      youtubeId: "YcTMc_Ee11w",
      title: "PvZ Stargate into Glaive Adept Timing",
      description: "First paragraph.\n\nBUILD CHECKLIST\n• Stargate at 150 gas\n",
      publishedAt: new Date("2026-08-29T00:00:00.000Z"),
      hidden: false,
      source: "snapshot",
    });
    expect(video).toEqual({
      youtubeId: "YcTMc_Ee11w",
      title: "PvZ Stargate into Glaive Adept Timing",
      publishedAt: "2026-08-29T00:00:00.000Z",
      url: "https://www.youtube.com/watch?v=YcTMc_Ee11w",
      thumbnailUrl: "https://i.ytimg.com/vi/YcTMc_Ee11w/hqdefault.jpg",
      embedUrl: "https://www.youtube-nocookie.com/embed/YcTMc_Ee11w",
      excerpt: "First paragraph.",
      checklist: ["Stargate at 150 gas"],
    });
  });

  test("an undated (admin-added) video has publishedAt null", () => {
    expect(toPublicVideo({ youtubeId: "AAAAAAAAAAA", title: "t", publishedAt: null }).publishedAt).toBeNull();
    expect(toPublicVideo({ youtubeId: "AAAAAAAAAAA", title: "t", publishedAt: "junk" }).publishedAt).toBeNull();
  });
});

// @ts-nocheck
"use strict";

/**
 * services/guideVideoMatch.js + guideVideoText.js over the committed,
 * real channel snapshot (config/guideVideosSnapshot.json): every one of
 * the 32 videos has its exact expected {matchup, builds, counters} and
 * checklist presence, so any rule change that adds or drops a match
 * shows up here for a human to judge.
 */

const fs = require("fs");
const path = require("path");
const SNAPSHOT = require("../src/config/guideVideosSnapshot.json");
const {
  normalizeMatchText,
  detectMatchup,
  isShortVideo,
  isStreamVideo,
  matchVideo,
  isValidCuratedLink,
  applyCuratedLinks,
} = require("../src/services/guideVideoMatch");
const { extractChecklist, extractExcerpt } = require("../src/services/guideVideoText");
const { parseChannelFeed } = require("../src/services/guideVideoFeed");
const { buildNamesForMatchup, strategyNamesForMatchup } = require("../src/config/guideSlugs");

const FEED_FIXTURE = path.join(__dirname, "fixtures", "guides", "youtube-channel-feed.xml");

const NONE = { matchup: null, builds: [], counters: [] };
/** @param {string} matchup @param {string[]} [builds] @param {string[]} [counters] */
const mu = (matchup, builds = [], counters = []) => ({ matchup, builds, counters });

/**
 * Automatic match (title/hashtag rule only) for EVERY snapshot video.
 * Streams (GM Protoss TRYING TO IMPROVE…), Shorts (YouTube /shorts/ link
 * or #Shorts), the channel trailer and the randomizer video match nothing.
 */
const EXPECTED_AUTO = {
  JjFO05IA6ZY: NONE, // stream VOD (portrait)
  fbLtIesBF8M: NONE, // stream VOD
  BknmAh0ug6Q: NONE, // Short (#Shorts)
  _U1MPQB_Q90: mu("PvT"), // AlphaStar PvT — no catalog name in title
  "1WX_FQ0nDqs": NONE, // Short (RSS /shorts/ link, no #Shorts tag)
  "AnmLN-xFtAc": mu("PvZ"), // "Dark Templar Into Skytoss" — no catalog name
  "6ng9WmvSQ4M": NONE, // Short (#Shorts)
  guRK0SIbM8Y: mu("PvZ"),
  "-E8lseUGWqQ": NONE, // Short (RSS /shorts/ link, no #Shorts tag)
  RYjRs_no8t4: mu("PvZ", ["PvZ - Carrier Rush"]),
  uMDkHVtNYEU: NONE, // stream VOD
  xXMd408hFuo: NONE, // stream VOD (portrait)
  crYAjWFJ5dY: NONE, // stream VOD (portrait)
  dItfRI6ze7s: NONE, // Short (#Shorts)
  "8wtBOX_D7Rs": NONE, // stream VOD
  "4St3Cit1jLQ": NONE, // channel trailer: no matchup token or hashtag
  aSGYCTVBjqY: mu("PvZ"),
  "-j6-FQ_6uMs": mu("PvZ"),
  O9XcnuUAycE: mu("PvZ"),
  H8PKfSR9u_s: mu("PvT", ["PvT - Stargate into Charge"]),
  XT1st30n8Zw: mu("PvZ"),
  dA9V95oeeto: mu("PvZ"), // curated below
  _EZbooc6wLM: mu("PvT", [], ["Terran - 3 Rax"]), // matchup from #PvT
  "5FJmQtglOxo": mu("PvT", ["PvT - DT Drop"]),
  psEgKVEdWeo: mu("PvT"), // "Protoss 1-1-1" is not the Terran 1-1-1 counter
  YcTMc_Ee11w: mu("PvZ", ["PvZ - Stargate into Glaives"]),
  KelX4RycY6Q: NONE, // randomizer: no matchup token or hashtag
  VcPGKEoPBYk: mu("PvP"), // "Proxy 1 Gate" ≠ "Proxy 2 Gate"
  "A4x6gR7J-AY": mu("PvZ", [], ["Zerg - 8 Pool"]),
  Jkyjd8R7Qfs: mu("PvP"), // curated below
  bMi6u0czxQI: mu("PvT"),
  "luGDs_-yVMs": mu("PvZ"),
};

/** Automatic match + the snapshot's curated links. */
const EXPECTED_EFFECTIVE = {
  ...EXPECTED_AUTO,
  dA9V95oeeto: mu("PvZ", ["PvZ - Rail's Disruptor Drop"]),
  Jkyjd8R7Qfs: mu("PvP", ["PvP - AlphaStar (4 Adept/Oracle)"]),
};

/** Checklist length per video (null = no qualifying section). */
const EXPECTED_CHECKLIST_LINES = {
  _EZbooc6wLM: 1, // STANDARD OPENER
  YcTMc_Ee11w: 10, // BUILD CHECKLIST
  VcPGKEoPBYk: 9, // QUICK BUILD NOTES
  "A4x6gR7J-AY": 10, // ▬▬ THE 8-POOL RESPONSE ▬▬
  Jkyjd8R7Qfs: 14, // FULL BUILD ORDER
  bMi6u0czxQI: 14, // FULL BUILD ORDER
  "luGDs_-yVMs": 19, // ▬▬ THE FULL BUILD ORDER ▬▬
};

describe("guide video snapshot", () => {
  test("holds the 32 real channel videos with unique valid ids and dates", () => {
    expect(SNAPSHOT.channelId).toBe("UCZS3YP1mvpqyuU5vPvHVG7g");
    expect(typeof SNAPSHOT.note).toBe("string");
    expect(SNAPSHOT.videos).toHaveLength(32);
    const ids = SNAPSHOT.videos.map((v) => v.youtubeId);
    expect(new Set(ids).size).toBe(32);
    for (const v of SNAPSHOT.videos) {
      expect(v.youtubeId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(Number.isNaN(Date.parse(v.publishedAt))).toBe(false);
      expect(typeof v.title).toBe("string");
      expect(typeof v.description).toBe("string");
      expect(typeof v.isShort).toBe("boolean");
    }
    expect(Object.keys(EXPECTED_AUTO).sort()).toEqual([...ids].sort());
  });

  test("curated links are valid catalog builds of their matchup", () => {
    expect(SNAPSHOT.curatedLinks).toHaveLength(2);
    for (const link of SNAPSHOT.curatedLinks) {
      expect(isValidCuratedLink(link)).toBe(true);
      expect(SNAPSHOT.videos.some((v) => v.youtubeId === link.youtubeId)).toBe(true);
    }
  });
});

describe("matchVideo over the whole snapshot", () => {
  test.each(SNAPSHOT.videos.map((v) => [v.youtubeId, v]))("%s automatic match", (id, video) => {
    expect(matchVideo(video)).toEqual(EXPECTED_AUTO[id]);
  });

  test.each(SNAPSHOT.videos.map((v) => [v.youtubeId, v]))("%s match with curated links", (id, video) => {
    expect(applyCuratedLinks(id, matchVideo(video), SNAPSHOT.curatedLinks)).toEqual(EXPECTED_EFFECTIVE[id]);
  });

  test("the contract's named expectations hold", () => {
    const by = Object.fromEntries(SNAPSHOT.videos.map((v) => [v.youtubeId, matchVideo(v)]));
    expect(by.YcTMc_Ee11w.builds).toEqual(["PvZ - Stargate into Glaives"]);
    expect(by.H8PKfSR9u_s.builds).toEqual(["PvT - Stargate into Charge"]);
    expect(by.RYjRs_no8t4.builds).toEqual(["PvZ - Carrier Rush"]);
    expect(by["5FJmQtglOxo"].builds).toEqual(["PvT - DT Drop"]);
    expect(by["A4x6gR7J-AY"].counters).toEqual(["Zerg - 8 Pool"]);
    expect(by._EZbooc6wLM.counters).toEqual(["Terran - 3 Rax"]);
  });

  test("every matched name belongs to its matchup's namespace", () => {
    for (const video of SNAPSHOT.videos) {
      const m = applyCuratedLinks(video.youtubeId, matchVideo(video), SNAPSHOT.curatedLinks);
      if (!m.matchup) continue;
      for (const name of m.builds) expect(buildNamesForMatchup(m.matchup)).toContain(name);
      for (const name of m.counters) expect(strategyNamesForMatchup(m.matchup)).toContain(name);
    }
  });

  test("the fuller RSS descriptions give the same match as the snapshot", () => {
    const feed = parseChannelFeed(fs.readFileSync(FEED_FIXTURE, "utf8"));
    expect(feed.length).toBeGreaterThan(0);
    for (const entry of feed) {
      const snap = SNAPSHOT.videos.find((v) => v.youtubeId === entry.youtubeId);
      expect(entry.isShort).toBe(snap.isShort);
      expect(matchVideo(entry)).toEqual(EXPECTED_AUTO[entry.youtubeId]);
    }
  });
});

describe("checklists and excerpts over the whole snapshot", () => {
  test.each(SNAPSHOT.videos.map((v) => [v.youtubeId, v]))("%s checklist", (id, video) => {
    const checklist = extractChecklist(video.description);
    if (EXPECTED_CHECKLIST_LINES[id] === undefined) {
      expect(checklist).toBeNull();
    } else {
      expect(checklist).toHaveLength(EXPECTED_CHECKLIST_LINES[id]);
      for (const line of checklist) {
        expect(line.length).toBeLessThanOrEqual(160);
        expect(line.startsWith("•")).toBe(false);
      }
    }
  });

  test.each(SNAPSHOT.videos.map((v) => [v.youtubeId, v]))("%s excerpt is the first paragraph, verbatim", (id, video) => {
    const excerpt = extractExcerpt(video.description);
    expect(excerpt.length).toBeGreaterThan(0);
    expect(excerpt.length).toBeLessThanOrEqual(300);
    const flat = video.description.replace(/ /g, " ").replace(/\s+/g, " ");
    expect(flat.startsWith(excerpt)).toBe(true);
  });

  test("checklists are the author's lines, bullets stripped", () => {
    const byId = Object.fromEntries(SNAPSHOT.videos.map((v) => [v.youtubeId, v]));
    expect(extractChecklist(byId.YcTMc_Ee11w.description).slice(0, 3)).toEqual([
      "14 Gateway / 17 Nexus on this four-player map",
      "Two Adepts for early scouting and pressure",
      "Stargate at 150 gas",
    ]);
    expect(extractChecklist(byId._EZbooc6wLM.description)).toEqual([
      "14 Gateway → 17 Nexus → 17 Gas → 17 Cybernetics Core",
    ]);
    expect(extractChecklist(byId["luGDs_-yVMs"].description)[0])
      .toBe("13 Gateway (worse economy, but 8-pool becomes survivable)");
    // "EVIDENCE NOTES" / "BUILD INSPIRATION" are sources, not build steps.
    expect(extractChecklist(byId.O9XcnuUAycE.description)).toBeNull();
    expect(extractChecklist(byId["-j6-FQ_6uMs"].description)).toBeNull();
  });
});

describe("matching rules", () => {
  test("normalisation folds case, punctuation, diacritics and simple plurals", () => {
    expect(normalizeMatchText("PvZ Cracking 8 Pools")).toBe("pvz cracking 8 pool");
    expect(normalizeMatchText("Stargate into Glaives")).toBe("stargate into glaive");
    expect(normalizeMatchText("Rail's Disruptor Drop")).toBe("rail s disruptor drop");
    expect(normalizeMatchText("Colossus Glass Gas")).toBe("colossus glass gas");
    expect(normalizeMatchText("Pylône")).toBe("pylone");
    expect(normalizeMatchText(null)).toBe("");
  });

  test("matchup comes from the title first, else a description hashtag", () => {
    expect(detectMatchup("pvz carriers", "#PvT")).toBe("PvZ");
    expect(detectMatchup("No token here", "text PvT text #ZvT")).toBe("ZvT");
    expect(detectMatchup("PvX and ZvZebra", "")).toBeNull();
    expect(detectMatchup("TVP reaper", "")).toBe("TvP");
  });

  test("Shorts and streams never match", () => {
    expect(isShortVideo({ title: "x", description: "clip #Shorts" })).toBe(true);
    expect(isShortVideo({ title: "x", description: "", isShort: true })).toBe(true);
    expect(isShortVideo({ title: "x", description: "#shortstop" })).toBe(false);
    expect(isStreamVideo({ title: "PvZ livestream", description: "" })).toBe(true);
    expect(isStreamVideo({ title: "PvZ LIVESTREAMED Carrier Rush", description: "" })).toBe(true);
    expect(isStreamVideo({ title: "PvZ #Stream highlights", description: "" })).toBe(true);
    expect(isStreamVideo({ title: "PvZ Carrier Rush", description: "" })).toBe(false);
    expect(isStreamVideo({ title: "PvZ Carrier Rush", description: "Support the stream: x" })).toBe(true);
    expect(isStreamVideo({ title: "PvZ Carrier Rush", description: "Intro\n \tSupport the stream: x" })).toBe(true);
    // Only a line that starts with it: a passing mention is not a stream VOD.
    expect(isStreamVideo({ title: "PvZ Carrier Rush", description: "Please support the stream" })).toBe(false);
    expect(matchVideo({ title: "PvZ Carrier Rush stream", description: "" })).toEqual(NONE);
    expect(matchVideo({ title: "PvZ Carrier Rush", description: "", isShort: true })).toEqual(NONE);
  });

  test("builds need whole words; the more specific name wins", () => {
    expect(matchVideo({ title: "PvT Stargate Openers galore", description: "" }).builds)
      .toEqual(["PvT - Stargate Opener"]);
    expect(matchVideo({ title: "PvT Stargate Openerx", description: "" }).builds).toEqual([]);
    // "Stargate into Glaives" contains no other PvZ phrase; "Stargate Opener" is not a sub-phrase.
    expect(matchVideo({ title: "PvZ Stargate into Glaives vs Stargate Opener", description: "" }).builds)
      .toEqual(["PvZ - Stargate Opener", "PvZ - Stargate into Glaives"]);
    // ZvP: "8 Pool Rush" (ZvP-prefixed) subsumes the race-generic "8 Pool".
    expect(matchVideo({ title: "PvZ 8 Pool Rush defense", description: "" }).counters)
      .toEqual(["ZvP - 8 Pool Rush"]);
  });

  test("builds come from the matchup's namespace only", () => {
    // "Carrier Rush" is a PvZ build; a PvT title naming it matches nothing.
    expect(matchVideo({ title: "PvT Carrier Rush", description: "" })).toEqual(mu("PvT"));
  });
});

describe("matching robustness and curated links", () => {
  test("newline-heavy descriptions stay linear (stream-line check)", () => {
    const started = Date.now();
    for (let i = 0; i < 50; i += 1) {
      expect(matchVideo({ title: "PvZ Carrier Rush", description: `${"\n".repeat(10000)}x` }).builds)
        .toEqual(["PvZ - Carrier Rush"]);
    }
    // ^\s* used to take ~130 ms per call here (quadratic over blank lines).
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("malformed input never throws", () => {
    expect(matchVideo(null)).toEqual(NONE);
    expect(matchVideo({})).toEqual(NONE);
    expect(matchVideo({ title: 42, description: {} })).toEqual(NONE);
  });

  test("curated links only apply when valid and consistent with the matchup", () => {
    const link = { youtubeId: "AAAAAAAAAAA", kind: "build", matchup: "PvZ", name: "PvZ - Carrier Rush" };
    expect(applyCuratedLinks("AAAAAAAAAAA", NONE, [link])).toEqual(mu("PvZ", ["PvZ - Carrier Rush"]));
    expect(applyCuratedLinks("AAAAAAAAAAA", mu("PvT"), [link])).toEqual(mu("PvT"));
    expect(applyCuratedLinks("BBBBBBBBBBB", NONE, [link])).toEqual(NONE);
    expect(isValidCuratedLink({ ...link, name: "PvZ - Not A Build" })).toBe(false);
    expect(isValidCuratedLink({ ...link, kind: "counter" })).toBe(false);
    expect(isValidCuratedLink({ ...link, kind: "counter", name: "Zerg - 8 Pool" })).toBe(true);
  });
});

// @ts-nocheck
"use strict";

/**
 * Where each player's recent builds may travel. They belong to the
 * desktop agent's private views: the device brief carries them in a short
 * form, the Companion snapshot carries them whole, and no overlay token
 * ever receives them.
 */

const {
  buildScoutingBrief,
  overlayEnvelope,
  SCOUTING_BRIEF_MAX_BYTES,
} = require("../src/services/agentScouting");
const { LiveGameBroker } = require("../src/services/liveGameBroker");

const flush = () => new Promise((resolve) => setImmediate(resolve));
/** One UTF-16 unit that is three UTF-8 bytes, to press on the byte cap. */
const WIDE_CHARACTER = String.fromCharCode(0x304c);

function row(index, overrides = {}) {
  return {
    gameId: `game-${index}`, result: index % 2 ? "Loss" : "Win", map: `Map ${index}`,
    build: `Build ${index}`, date: "2026-11-01T12:00:00.000Z", ...overrides,
  };
}

function recentBuilds(mine = 2, theirs = 2) {
  return {
    matchup: "PvZ",
    mine: Array.from({ length: mine }, (_, index) => row(index)),
    theirs: Array.from({ length: theirs }, (_, index) => row(index, { race: "Zerg" })),
  };
}

function envelope(history = {}) {
  return {
    type: "liveGameState", phase: "match_loading", gameKey: "current",
    opponent: { name: "Opponent", toonHandle: "1-S2-1-42" },
    streamerHistory: {
      oppName: "Opponent", headToHead: { wins: 3, losses: 2 },
      opponentNotes: { text: "Private note", readAloud: false },
      ...history,
    },
  };
}

describe("recent builds on the device brief", () => {
  test("carries the result and build of each game and nothing else", () => {
    const brief = buildScoutingBrief(envelope({ recentBuilds: recentBuilds(2, 1) }));
    expect(brief.recentBuilds).toEqual({
      matchup: "PvZ",
      mine: [{ result: "Win", build: "Build 0" }, { result: "Loss", build: "Build 1" }],
      theirs: [{ result: "Win", build: "Build 0" }],
    });
  });

  test("lists five games at most on each side", () => {
    const brief = buildScoutingBrief(envelope({ recentBuilds: recentBuilds(9, 7) }));
    expect(brief.recentBuilds.mine.map((game) => game.build)).toEqual(["Build 0", "Build 1", "Build 2", "Build 3", "Build 4"]);
    expect(brief.recentBuilds.theirs).toHaveLength(5);
  });

  test("a first meeting sends an empty opponent list, not a missing one", () => {
    const brief = buildScoutingBrief(envelope({ headToHead: { wins: 0, losses: 0 }, recentBuilds: recentBuilds(3, 0) }));
    expect(brief.recentBuilds.theirs).toEqual([]);
    expect(brief.recentBuilds.mine).toHaveLength(3);
  });

  test("an opponent whose account is unknown keeps an unknown list, not a first meeting", () => {
    const brief = buildScoutingBrief(envelope({ recentBuilds: { ...recentBuilds(3, 0), theirs: null } }));
    expect(brief.recentBuilds.theirs).toBeNull();
    expect(brief.recentBuilds.mine).toHaveLength(3);
  });

  test("an enrichment without the lists sends today's brief unchanged", () => {
    const brief = buildScoutingBrief(envelope());
    expect(brief).not.toBeNull();
    expect("recentBuilds" in brief).toBe(false);
    for (const malformed of [null, "PvZ", [], 5]) {
      expect("recentBuilds" in buildScoutingBrief(envelope({ recentBuilds: malformed }))).toBe(false);
    }
  });

  test("bounds every field and never invents a result or a matchup", () => {
    const brief = buildScoutingBrief(envelope({ recentBuilds: {
      matchup: "Protoss versus Zerg",
      mine: [row(0, { result: "Victory", build: "x".repeat(500) }), null, "row", row(1, { build: 42 })],
      theirs: "not a list",
    } }));
    expect(brief.recentBuilds).toEqual({
      matchup: null,
      mine: [{ result: null, build: "x".repeat(80) }, { result: "Loss", build: "" }],
      // A malformed opponent list is unknown, never a first meeting.
      theirs: null,
    });
    for (const matchup of ["PvZ and more", " PvZ", "pvz", 5, null]) {
      expect(buildScoutingBrief(envelope({ recentBuilds: { matchup, mine: [], theirs: [] } })).recentBuilds.matchup).toBeNull();
    }
  });

  test("stays valid when a name-only match set the opponent's record aside", () => {
    const brief = buildScoutingBrief(envelope({ opponentIdentityMatched: false, recentBuilds: recentBuilds(1, 0) }));
    expect(brief.h2h).toBeNull();
    expect(brief.recentBuilds.mine).toEqual([{ result: "Win", build: "Build 0" }]);
  });

  test("over the byte cap the lists are dropped before anything an older agent shows", () => {
    const wide = WIDE_CHARACTER.repeat(1000);
    const heavy = {
      opponentNotes: { text: wide, readAloud: false },
      oppRevealedName: wide,
      alsoPlaysAs: [wide + "1", wide + "2", wide + "3"],
      recentGames: Array.from({ length: 3 }, () => ({ result: "Win", map: wide, oppBuild: wide, date: "2026-10-21T12:00:00Z" })),
      favOpening: { name: wide, share: 0.6, samples: 3, of: 5 },
      bestAnswer: { build: wide, total: 4, winRate: 0.75 },
    };
    const builds = recentBuilds(5, 5);
    for (const game of [...builds.mine, ...builds.theirs]) game.build = wide;
    const withoutLists = buildScoutingBrief(envelope(heavy));
    const short = { result: "Win", build: WIDE_CHARACTER.repeat(80) };
    expect(withoutLists).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify({ ...withoutLists, recentBuilds: { matchup: "PvZ", mine: Array(5).fill(short), theirs: Array(5).fill(short) } })))
      .toBeGreaterThan(SCOUTING_BRIEF_MAX_BYTES);
    expect(buildScoutingBrief(envelope({ ...heavy, recentBuilds: builds }))).toEqual(withoutLists);
  });
});

describe("recent builds never reach an overlay token", () => {
  test("the overlay envelope loses only the lists and the cached one is untouched", () => {
    const cached = envelope({ recentBuilds: recentBuilds() });
    const shared = overlayEnvelope(cached);
    expect("recentBuilds" in shared.streamerHistory).toBe(false);
    expect(shared).toEqual({ ...cached, streamerHistory: { oppName: "Opponent", headToHead: { wins: 3, losses: 2 }, opponentNotes: { text: "Private note", readAloud: false } } });
    expect(cached.streamerHistory.recentBuilds).toEqual(recentBuilds());
  });

  test("an envelope without the lists passes through as the same object", () => {
    const plain = envelope();
    expect(overlayEnvelope(plain)).toBe(plain);
    expect(overlayEnvelope(null)).toBeNull();
    const partial = { type: "liveGameState", phase: "match_loading" };
    expect(overlayEnvelope(partial)).toBe(partial);
  });

  test("the broker sends them to the device and the Companion snapshot, not to OBS", async () => {
    const events = [];
    const io = { to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
    const broker = new LiveGameBroker({
      io,
      overlayTokens: { list: async () => [{ token: "tok_obs", revokedAt: null }] },
      enrich: async (_, env) => ({ ...env, streamerHistory: envelope({ recentBuilds: recentBuilds() }).streamerHistory }),
    });
    const published = envelope();
    delete published.streamerHistory;
    broker.publish("owner", published);
    await flush();
    await flush();

    const overlay = events.filter((entry) => entry.room === "overlay:tok_obs" && entry.payload.streamerHistory);
    expect(overlay).toHaveLength(1);
    expect(overlay[0].event).toBe("overlay:liveGame");
    expect(overlay[0].payload.streamerHistory.headToHead).toEqual({ wins: 3, losses: 2 });
    expect("recentBuilds" in overlay[0].payload.streamerHistory).toBe(false);

    const brief = events.find((entry) => entry.event === "scouting:brief");
    expect(brief.room).toBe("device-user:owner");
    expect(brief.payload.recentBuilds.theirs).toEqual([{ result: "Win", build: "Build 0" }, { result: "Loss", build: "Build 1" }]);

    expect(broker.latest("owner").streamerHistory.recentBuilds).toEqual(recentBuilds());
    expect("recentBuilds" in broker.replayLatestForOverlay("owner").envelope.streamerHistory).toBe(false);
  });
});

"use strict";
const { deriveGameMoments, ladderContext } = require("../src/services/gameMomentRules");
const { sanitizeGameMoments } = require("../src/services/gameMomentConfig");
const NOW = Date.parse("2026-10-25T12:00:00Z");
const game = (/** @type {Record<string,any>} */ patch = {}) => ({ userId: "owner", gameId: "current", date: new Date(NOW), playerCount: 2,
  isLadderGame: true, result: "Victory", myToonHandle: "1-S2-1-42", myRace: "Protoss", myMmr: 4001, myMmrSource: "replay",
  durationSec: 600, opponent: { pulseCharacterId: "77", displayName: "Enemy", mmr: 4100, mmrSource: "replay" }, ...patch });
const prior = (/** @type {Record<string,any>} */ patch = {}) => game({ gameId: "previous", date: new Date(NOW - 3600000), myMmr: 3990, ...patch });
const kinds = (/** @type {Parameters<typeof deriveGameMoments>[0]} */ input) => deriveGameMoments(input).map(moment => moment.kind);
const season = { battlenetId: 70, start: "2026-10-01" };

describe("recorded ladder moment rules", () => {
  test.each([100, 250])("MMR milestone uses recorded start ratings and the configured %i step", mmrStep => {
    const moments = deriveGameMoments({ game: game(), history: [prior()], mmrStep });
    expect(moments.find(moment => moment.kind === "crossedMmrMark")).toEqual({ kind: "crossedMmrMark", headline: "Recorded 4000 MMR", detail: expect.stringContaining("not this game's awarded rating") });
  });
  test.each([null, undefined, 0, NaN, "4001"])("null/non-numeric MMR cannot become a milestone or giant killer: %s", myMmr => {
    const value = kinds({ game: game({ myMmr }), history: [prior()], season });
    expect(value).not.toContain("crossedMmrMark"); expect(value).not.toContain("newSeasonPeak"); expect(value).not.toContain("giantKiller");
  });
  test("unknown rating provenance, another account/race and PTR cannot fake a recorded crossing", () => {
    expect(kinds({ game: game({ myMmrSource: "unavailable" }), history: [prior()] })).not.toContain("crossedMmrMark");
    for (const patch of [{ myToonHandle: "2-S2-1-42" }, { myRace: "Terran" }, { myToonHandle: "98-S2-1-42" }]) {
      expect(kinds({ game: game(patch), history: [prior()] })).not.toContain("crossedMmrMark");
    }
  });
  test("season peak requires a real cached boundary, earlier rating and complete time coverage", () => {
    expect(kinds({ game: game(), history: [prior()], season })).toContain("newSeasonPeak");
    for (const input of [{ season: null }, { history: [] }, { historyTruncated: true }, { historyTruncated: true, history: [prior({ date: "invalid" })] }]) {
      expect(kinds({ game: game(), history: [prior()], season, ...input })).not.toContain("newSeasonPeak");
    }
    expect(kinds({ game: game(), history: [prior({ date: new Date("2026-09-30") }), prior()], season, historyTruncated: true })).toContain("newSeasonPeak");
    expect(kinds({ game: game(), history: [prior({ myMmr: 5000, myToonHandle: "2-S2-1-77" }), prior()], season })).toContain("newSeasonPeak");
  });
  test("only an actual prior same-context same-season Pulse snapshot can establish a league change", () => {
    const context = ladderContext(game())?.key;
    const rank = { source: "pulse", league: "Diamond", context, season: 70 };
    const input = { game: game(), history: [prior({ _gameMoments: { rank } })], season, pulseRank: { source: "pulse", league: "Master" } };
    expect(kinds(input)).toContain("leagueChange");
    for (const patch of [{ history: [] }, { pulseRank: { source: "estimate", league: "Master" } }, { season: null }, { history: [prior({ _gameMoments: { rank: { ...rank, source: "estimate" } } })] }, { season: { ...season, battlenetId: 71 } }]) {
      expect(kinds({ ...input, ...patch })).not.toContain("leagueChange");
    }
  });
});
describe("recorded victory moment rules", () => {
  test.each([5, 10])("win streak celebrates exactly %i decided wins", count => {
    const history = Array.from({ length: count - 1 }, (_, i) => prior({ gameId: `prior${i}`, myMmr: 4001 }));
    expect(deriveGameMoments({ game: game(), history }).find(moment => moment.kind === "winStreak")?.headline).toBe(`${count} wins in a row`);
    expect(kinds({ game: game(), history: [...history, prior({ gameId: "extra", myMmr: 4001 })] })).not.toContain("winStreak");
  });
  test("breaks a loss streak at four, without treating unknown results as decided history", () => {
    const history = Array.from({ length: 4 }, (_, i) => prior({ gameId: `loss${i}`, result: "Defeat" }));
    expect(kinds({ game: game(), history })).toContain("lossStreakBroken");
    expect(kinds({ game: game(), history: history.slice(1) })).not.toContain("lossStreakBroken");
    expect(kinds({ game: game(), history: [prior({ result: "Undecided" }), ...history] })).not.toContain("lossStreakBroken");
  });
  test("revenge uses the latest exact opponent identity, never a matching display name", () => {
    expect(kinds({ game: game(), history: [prior({ result: "Defeat" })] })).toContain("revengeWin");
    expect(kinds({ game: game(), history: [prior({ result: "Defeat", opponent: { pulseCharacterId: "88", displayName: "Enemy" } })] })).not.toContain("revengeWin");
    expect(kinds({ game: game(), history: [prior(), prior({ gameId: "older", result: "Defeat" })] })).not.toContain("revengeWin");
  });
  test("giant killer compares replay ratings only and requires a win and at least200 MMR", () => {
    const opponent = { pulseCharacterId: "77", mmr: 4201, mmrSource: "replay" };
    expect(kinds({ game: game({ opponent }), history: [] })).toContain("giantKiller");
    for (const patch of [{ result: "Defeat" }, { opponent: { ...opponent, mmr: 4200 } }, { opponent: { ...opponent, mmr: null } }, { opponent: { ...opponent, mmrSource: "pulse" } }]) {
      expect(kinds({ game: game({ opponent, ...patch }), history: [] })).not.toContain("giantKiller");
    }
  });
  test("marathon and streamer wins need their actual threshold/approved-channel evidence", () => {
    expect(kinds({ game: game({ durationSec: 1500 }), history: [], approvedChannel: true })).toEqual(expect.arrayContaining(["marathonWin", "streamerOpponentWin"]));
    for (const patch of [{ durationSec: 1499 }, { durationSec: null }, { durationSec: 1500, result: "Defeat" }]) expect(kinds({ game: game(patch), history: [] })).not.toContain("marathonWin");
    expect(kinds({ game: game(), history: [], approvedChannel: false })).not.toContain("streamerOpponentWin");
  });
  test.each([{ excluded: true }, { _deleted: true }, { _deletionPending: true }, { isResumedFromReplay: true }, { playerCount: 4 }, { isLadderGame: false }])("noncontributing source cannot produce moments: %j", patch => {
    expect(deriveGameMoments({ game: game({ ...patch, durationSec: 1500 }), history: [prior()], season, approvedChannel: true })).toEqual([]);
  });
});

describe("strict bounded moment preferences", () => {
  const options = { strict: true, preset: (/** @type {unknown} */ value) => typeof value === "string" && ["classic", "victory-lap"].includes(value), sound: (/** @type {unknown} */ value) => typeof value === "string" && ["ding", "victory"].includes(value) };
  test("defaults to opt-in visuals with no sounds or bot posts", () => {
    const value = sanitizeGameMoments(undefined); expect(value.botPost).toBe(false); expect(value.mmrStep).toBe(100);
    expect(Object.keys(value.moments)).toHaveLength(9); expect(Object.values(value.moments).every(row => !row.enabled && row.sound === "none")).toBe(true);
  });
  test("partial valid settings normalize into one complete snapshot", () => {
    expect(sanitizeGameMoments({ mmrStep: 250, moments: { winStreak: { enabled: true, preset: "classic", sound: "victory" } } }, options)).toMatchObject({ mmrStep: 250, moments: { winStreak: { enabled: true, preset: "classic", sound: "victory" } } });
  });
  test.each([{ mmrStep: 0 }, { botPost: 1 }, { unknown: true }, { moments: [] }, { moments: { unknown: {} } }, { moments: { winStreak: { enabled: 1 } } }, { moments: { winStreak: { preset: "bogus" } } }, { moments: { winStreak: { sound: "https://example.test/file.mp3" } } }])("rejects malformed settings: %j", raw => expect(() => sanitizeGameMoments(raw, options)).toThrow());
});

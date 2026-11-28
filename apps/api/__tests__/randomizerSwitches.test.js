// @ts-nocheck
"use strict";

const { envelopeMatchup, streamerRace } = require("../src/services/buildIntentCommon");
const { TwitchRewardActions } = require("../src/services/twitchRewardActions");

const USER = "streamer-1";
const TOKEN = "overlay-token";
const GAME = "Foe|Streamer|1790000000000";

function queuedRandom(reported) {
  return {
    phase: "match_started", gameKey: GAME, displayTime: 3,
    user: { name: "Streamer", race: "Random" }, opponent: { name: "Foe", race: "Protoss" },
    players: [{ name: "Streamer", type: "user", race: reported }, { name: "Foe", type: "user", race: "Prot" }],
  };
}

describe("the streamer's race in a live envelope", () => {
  test("a streamer who queued Random counts with the race the client reveals", () => {
    expect(envelopeMatchup(queuedRandom("Zerg"))).toBe("ZvP");
    expect(envelopeMatchup(queuedRandom("random"))).toBeNull();
    expect(envelopeMatchup(queuedRandom("?"))).toBeNull();
  });

  test("a concrete race stands, and a Random opponent never resolves", () => {
    expect(envelopeMatchup({ user: { race: "Terr" }, opponent: { race: "Zerg" } })).toBe("TvZ");
    expect(envelopeMatchup({ ...queuedRandom("Zerg"), opponent: { race: "Random" } })).toBeNull();
  });

  test("two players of the streamer's name, or no name, are never guessed between", () => {
    const twins = { ...queuedRandom("Zerg"), players: [
      { name: "Streamer", type: "user", race: "Zerg" }, { name: "Streamer", type: "user", race: "Terran" },
    ] };
    expect(streamerRace(twins)).toBe("Random");
    expect(streamerRace({ ...queuedRandom("Zerg"), user: { race: "Random" } })).toBe("Random");
  });
});

function rewardActions(randomizer) {
  return new TwitchRewardActions({
    tokens: { resolve: async () => ({ userId: USER, enabledWidgets: ["randomizer"] }) },
    io: { in: (room) => ({ fetchSockets: async () => (room === `user:${USER}` ? [{ data: { kind: "device", userId: USER } }] : []) }) },
    broker: { currentGameKey: () => GAME },
    buildIntents: { live: {
      users: { findOne: async () => ({ preferences: { randomizer } }) },
      rewardReroll: jest.fn(async () => undefined),
    } },
  });
}

function zergPool(enabled, unitRandomizerEnabled) {
  return { version: 3, matchups: { ZvP: {
    enabled, unitRandomizerEnabled,
    builds: [{ id: "a", name: "A", race: "Zerg" }, { id: "b", name: "B", race: "Zerg" }],
    units: { gateCount: 1, units: [{ id: "zergling", weight: 1 }] },
  } } };
}

describe("the channel-point reroll follows the build switch", () => {
  test.each([false, true])("is offered while a build is drawn (units=%s)", async (units) => {
    await expect(rewardActions(zergPool(true, units)).canQueueNextGame(USER, TOKEN)).resolves.toEqual({ gameKey: GAME });
  });

  test("is not offered for units drawn alone: there is no build to reroll", async () => {
    await expect(rewardActions(zergPool(false, true)).canQueueNextGame(USER, TOKEN)).resolves.toBeNull();
  });

  test("rerolls a Random streamer's draw in the matchup they got", async () => {
    const reward = rewardActions(zergPool(true, true));
    jest.spyOn(reward, "isDeviceMatch").mockReturnValue(true);
    await reward.roll(USER, { enabledWidgets: ["randomizer"] }, { redemptionId: "r1", assertDispatch: jest.fn() }, queuedRandom("Zerg"));
    expect(reward.deps.buildIntents.live.rewardReroll).toHaveBeenCalledWith(USER, GAME, "ZvP", "r1");
  });
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { transform } = require("../transform");

test("transform: builds game records from MyOpponentHistory.json", () => {
  const raw = {
    opponents: {
      "452727": {
        Name: "Hiza",
        Race: "Terran",
        Matchups: {
          PROTOSSvTERRAN: {
            Wins: 1,
            Losses: 0,
            Games: [
              { Date: "2018-07-16 15:16:53", Result: "Victory", Map: "Redshift LE" },
            ],
          },
        },
      },
    },
    meta: {},
    customBuilds: {},
    profile: null,
  };
  const out = transform(raw);
  assert.equal(out.games.length, 1);
  const g = out.games[0];
  assert.equal(g.result, "Victory");
  assert.equal(g.myRace, "Protoss");
  assert.equal(g.map, "Redshift LE");
  assert.equal(g.opponent.pulseId, "452727");
  assert.equal(g.opponent.race, "Terran");
  assert.match(g.gameId, /^[a-f0-9]{24}$/);
  assert.match(g.date, /^2018-07-16T/);
});

test("transform: dedupes when the same game appears in two matchups", () => {
  const raw = {
    opponents: {
      "1": {
        Name: "Foo",
        Race: "",
        Matchups: {
          Unknown: {
            Wins: 1,
            Losses: 0,
            Games: [{ Date: "2026-01-01 12:00:00", Result: "Victory", Map: "M" }],
          },
          PROTOSSvUNKNOWN: {
            Wins: 1,
            Losses: 0,
            Games: [{ Date: "2026-01-01 12:00:00", Result: "Victory", Map: "M" }],
          },
        },
      },
    },
    meta: {},
    customBuilds: {},
    profile: null,
  };
  const out = transform(raw);
  assert.equal(out.games.length, 1);
});

test("transform: enriches matching games with meta_database build info", () => {
  const raw = {
    opponents: {
      "p1": {
        Name: "SpeCial",
        Race: "Protoss",
        Matchups: {
          PROTOSSvPROTOSS: {
            Wins: 1,
            Losses: 0,
            Games: [
              { Date: "2026-01-11 16:48:51", Result: "Victory", Map: "10000 Feet LE" },
            ],
          },
        },
      },
    },
    meta: {
      "PvP - 4 Stalker Oracle into DT": {
        wins: 1,
        losses: 0,
        games: [
          {
            id: "2026-01-11T16:48:51|SpeCial|10000 Feet LE|384",
            opponent: "SpeCial",
            opp_race: "Protoss",
            opp_strategy: "Protoss - Standard Expand",
            map: "10000 Feet LE",
            result: "Win",
            date: "2026-01-11T16:48:51",
            game_length: 384,
            build_log: ["[0:00] Probe"],
            macro_score: 77,
          },
        ],
      },
    },
    customBuilds: {},
    profile: null,
  };
  const out = transform(raw);
  assert.equal(out.games.length, 1, "should not produce a duplicate");
  const g = out.games[0];
  assert.equal(g.myBuild, "PvP - 4 Stalker Oracle into DT");
  assert.equal(g.durationSec, 384);
  assert.equal(g.macroScore, 77);
  assert.equal(g.opponent.strategy, "Protoss - Standard Expand");
  assert.deepEqual(g.buildLog, ["[0:00] Probe"]);
});

test("transform: standalone meta game (no opp match) becomes a record", () => {
  const raw = {
    opponents: {},
    meta: {
      "Z - Pool first": {
        wins: 1,
        losses: 0,
        games: [
          {
            id: "abc",
            opponent: "Joe",
            opp_race: "Terran",
            map: "Map A",
            result: "Loss",
            date: "2026-02-02T10:00:00",
            game_length: 600,
            build_log: ["[0:00] Drone"],
          },
        ],
      },
    },
    customBuilds: {},
    profile: null,
  };
  const out = transform(raw);
  assert.equal(out.games.length, 1);
  const g = out.games[0];
  assert.equal(g.result, "Defeat");
  assert.equal(g.myBuild, "Z - Pool first");
  assert.equal(g.myRace, "Zerg");
  assert.equal(g.opponent.race, "Terran");
});

test("transform: custom_builds shape", () => {
  const raw = {
    opponents: {},
    meta: {},
    customBuilds: {
      version: 3,
      builds: [
        {
          id: "pvz-dt-into-3-stargate",
          name: "PvZ - DT into 3 Stargate",
          race: "Protoss",
          vs_race: "Zerg",
          rules: [{ type: "before", name: "X", time_lt: 100 }],
          author: "Me",
        },
      ],
    },
    profile: null,
  };
  const out = transform(raw);
  assert.equal(out.customBuilds.length, 1);
  const b = out.customBuilds[0];
  assert.equal(b.slug, "pvz-dt-into-3-stargate");
  assert.equal(b.race, "Protoss");
  assert.deepEqual(b.rules, [{ type: "before", name: "X", time_lt: 100 }]);
});

test("transform: profile mapping", () => {
  const out = transform({
    opponents: {},
    meta: {},
    customBuilds: {},
    profile: {
      version: 1,
      battlenet: {
        battle_tag: "ReSpOnSe#1872",
        character_id: "1-S2-1-267727",
        account_id: "50983875",
        region: "us",
      },
      races: ["Protoss"],
      mmr_target: 6000,
      preferred_player_name_in_replays: "ReSpOnSe",
    },
  });
  assert.equal(out.profile.battleTag, "ReSpOnSe#1872");
  assert.equal(out.profile.region, "us");
  assert.equal(out.profile.mmrTarget, 6000);
  assert.deepEqual(out.profile.races, ["Protoss"]);
});

test("transform: gracefully handles empty/missing fields", () => {
  const out = transform({ opponents: {}, meta: {}, customBuilds: {}, profile: null });
  assert.deepEqual(out.games, []);
  assert.deepEqual(out.customBuilds, []);
  assert.equal(out.profile, null);
});

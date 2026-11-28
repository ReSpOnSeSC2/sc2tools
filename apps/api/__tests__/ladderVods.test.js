// @ts-nocheck
"use strict";

/**
 * Ladder VOD finder (services/ladderVodSearch.js, ladderVods.js,
 * twitchVideoChannels.js and routes/ladderVods.js) against fake SC2Pulse and
 * Twitch fetches: the fixed search space, what a result may carry (ADR 0075),
 * the gate, the cache, the one-a-second pace and the public route.
 */

const express = require("express");
const request = require("supertest");
const { parseSearch, shapeMatch } = require("../src/services/ladderVodSearch");
const { LadderVodsService, CACHE_TTL_MS, STALE_LIMIT_MS, PACE_MS } = require("../src/services/ladderVods");
const { buildTwitchVideoChannelResolver } = require("../src/services/twitchVideoChannels");
const { buildLadderVodsRouter } = require("../src/routes/ladderVods");

const reply = (body, status = 200) => ({
  ok: status < 400,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => JSON.stringify(body),
  json: async () => body,
});

const participant = ({ rating, race, vod, name = "SecretName#123", sub = false }) => ({
  participant: { matchId: 1, decision: "WIN" },
  team: { rating, members: [{ character: { name }, account: { battleTag: `${name}#1` }, raceGames: { [race]: 40 } }] },
  teamState: { teamState: { rating } },
  twitchVodUrl: vod ?? null,
  subOnlyTwitchVod: sub,
});

const vodUrl = (id, seconds) => `https://www.twitch.tv/videos/${id}?t=${seconds}s`;

const match = (id, over = {}) => ({
  match: { id, date: "2026-11-27T18:18:50Z", duration: 764, mapId: 55373 },
  map: { id: 55373, name: "Blackrock LE" },
  participants: [
    participant({ rating: 6694, race: "ZERG", vod: vodUrl(2942397497, 1543), name: "StreamerName" }),
    participant({ rating: 5897, race: "TERRAN", name: "OtherPlayer" }),
  ],
  ...over,
});

describe("parseSearch", () => {
  test("turns fixed choices into a sorted Pulse query", () => {
    const search = parseSearch({ matchup: "tvz", rating: "5000", length: "10", map: "55373" });
    expect(Object.fromEntries(search.query)).toEqual({
      vod: "true", race: "TERRAN", raceVersus: "ZERG", ratingMin: "5000", ratingMax: "5999",
      durationMin: "600", durationMax: "899", mapId: "55373",
    });
    expect(search.matchup).toEqual(["TERRAN", "ZERG"]);
    expect(search.key).toBe(parseSearch({ map: "55373", length: "10", rating: "5000", matchup: "tvz" }).key);
  });

  test("open-ended bands send only their lower bound, and no choice sends only vod", () => {
    expect(Object.fromEntries(parseSearch({ rating: "6000", length: "20" }).query))
      .toEqual({ vod: "true", ratingMin: "6000", durationMin: "1200" });
    expect(Object.fromEntries(parseSearch({}).query)).toEqual({ vod: "true" });
    expect(Object.fromEntries(parseSearch({ rating: "0" }).query)).toEqual({ vod: "true", ratingMax: "2999" });
  });

  test.each([
    [{ matchup: "tvq" }], [{ rating: "4500" }], [{ length: "7" }], [{ map: "1" }], [{ map: "55373; drop" }],
    [{ after: "has space" }], [{ after: "x".repeat(513) }], [{ matchup: ["tvz", "tvp"] }], [{ matchup: "__proto__" }],
  ])("refuses %j", input => expect(parseSearch(input)).toBeNull());

  test("passes a well-formed cursor through", () => {
    expect(parseSearch({ after: "eyJyZWdpb24iOjJ9" }).query.get("after")).toBe("eyJyZWdpb24iOjJ9");
  });
});

describe("shapeMatch", () => {
  const tvz = ["TERRAN", "ZERG"];

  test("keeps the streamer's channel link, both races, a rating rounded to 100, map, length and age", () => {
    const shaped = shapeMatch(match(642164396), tvz);
    expect(shaped).toEqual({
      id: "642164396",
      vodUrl: vodUrl(2942397497, 1543),
      videoId: "2942397497",
      subscribersOnly: false,
      streamerRace: "zerg",
      opponentRace: "terran",
      rating: 6700,
      map: "Blackrock LE",
      durationSec: 764,
      playedAt: "2026-11-27T18:18:50.000Z",
    });
  });

  test("never carries the other player's name, tag or ids", () => {
    const text = JSON.stringify(shapeMatch(match(1), tvz));
    expect(text).not.toMatch(/OtherPlayer|StreamerName|SecretName|battleTag|5897|5124994/);
  });

  test("with two VODs the higher-rated player is the streamer", () => {
    const row = match(2, {
      participants: [
        participant({ rating: 5900, race: "TERRAN", vod: vodUrl(11, 5) }),
        participant({ rating: 6100, race: "ZERG", vod: vodUrl(22, 9) }),
      ],
    });
    expect(shapeMatch(row, tvz)).toMatchObject({ videoId: "22", streamerRace: "zerg", opponentRace: "terran", rating: 6100 });
  });

  test("assigns races by the team's games with the matchup asked for", () => {
    const row = match(3, {
      participants: [
        participant({ rating: 4000, race: "ZERG", vod: vodUrl(5, 5) }),
        participant({ rating: 4000, race: "TERRAN" }),
      ],
    });
    expect(shapeMatch(row, tvz)).toMatchObject({ streamerRace: "zerg", opponentRace: "terran" });
    expect(shapeMatch(row, null)).toMatchObject({ streamerRace: "zerg", opponentRace: "terran" });
  });

  test("marks subscriber-only VODs and rounds .5 up", () => {
    const row = match(4, { participants: [participant({ rating: 4950, race: "ZERG", vod: vodUrl(6, 1), sub: true }), participant({ rating: 1, race: "TERRAN" })] });
    expect(shapeMatch(row, tvz)).toMatchObject({ subscribersOnly: true, rating: 5000 });
  });

  test.each([
    ["no VOD", match(5, { participants: [participant({ rating: 1, race: "ZERG" }), participant({ rating: 1, race: "TERRAN" })] })],
    ["a non-Twitch VOD", match(6, { participants: [participant({ rating: 1, race: "ZERG", vod: "https://evil.test/videos/1?t=5s" }), participant({ rating: 1, race: "TERRAN" })] })],
    ["three players", match(7, { participants: [participant({ rating: 1, race: "ZERG", vod: vodUrl(1, 1) }), participant({ rating: 1, race: "TERRAN" }), participant({ rating: 1, race: "TERRAN" })] })],
    ["no map", match(8, { map: undefined })],
    ["no length", match(9, { match: { id: 9, date: "2026-11-27T18:18:50Z" } })],
    ["a bad date", match(10, { match: { id: 10, date: "yesterday", duration: 60 } })],
  ])("skips a game with %s", (_label, row) => expect(shapeMatch(row, tvz)).toBeNull());
});

function pulseFetch(pages) {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = pages.shift();
    return typeof next === "function" ? next() : reply(next);
  });
  return { fetchImpl, calls };
}

const page = (rows, after = "next-cursor") => ({ result: rows, navigation: { before: null, after } });

function makeService(pages, extra = {}) {
  const clock = { at: 1_000_000 };
  const sleeps = [];
  const { fetchImpl, calls } = pulseFetch(pages);
  const service = new LadderVodsService({
    enabled: true,
    fetchImpl,
    now: () => clock.at,
    sleep: async ms => { sleeps.push(ms); clock.at += ms; },
    resolveChannels: async ids => new Map(ids.map(id => [id, `chan${id}`])),
    ...extra,
  });
  return { service, clock, sleeps, fetchImpl, calls };
}

describe("LadderVodsService", () => {
  test("with the gate off it answers unavailable and never calls SC2Pulse or Twitch", async () => {
    const resolveChannels = jest.fn();
    const { service, fetchImpl } = makeService([], { enabled: false, resolveChannels });
    await expect(service.search({ matchup: "tvz" })).resolves.toEqual({ available: false });
    await expect(service.search({ matchup: "nonsense" })).resolves.toEqual({ available: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveChannels).not.toHaveBeenCalled();
  });

  test("the gate follows SC2TOOLS_LADDER_VODS_ENABLED and starts off", () => {
    const saved = process.env.SC2TOOLS_LADDER_VODS_ENABLED;
    try {
      delete process.env.SC2TOOLS_LADDER_VODS_ENABLED;
      expect(new LadderVodsService().enabled).toBe(false);
      process.env.SC2TOOLS_LADDER_VODS_ENABLED = "1";
      expect(new LadderVodsService().enabled).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SC2TOOLS_LADDER_VODS_ENABLED;
      else process.env.SC2TOOLS_LADDER_VODS_ENABLED = saved;
    }
  });

  test("one search is one call with a generic client name, and results carry the channel", async () => {
    const { service, calls } = makeService([page([match(1)])]);
    const answer = await service.search({ matchup: "tvz", rating: "5000" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin + calls[0].url.pathname).toBe("https://sc2pulse.nephest.com/sc2/api/matches");
    expect(calls[0].init.headers["user-agent"]).toBe("sc2tools.com ladder-vods (+https://sc2tools.com)");
    expect(answer.available).toBe(true);
    expect(answer.next).toBe("next-cursor");
    expect(answer.results).toEqual([expect.objectContaining({ id: "1", channel: "chan2942397497", rating: 6700 })]);
    expect(answer.results[0]).not.toHaveProperty("videoId");
  });

  test("the same search inside the cache time costs no call; after it, one", async () => {
    const { service, clock, calls } = makeService([page([match(1)]), page([match(2)])]);
    await service.search({ matchup: "tvz" });
    clock.at += CACHE_TTL_MS - 1;
    const again = await service.search({ matchup: "tvz" });
    expect(calls).toHaveLength(1);
    expect(again.results[0].id).toBe("1");
    clock.at += 2;
    const later = await service.search({ matchup: "tvz" });
    expect(calls).toHaveLength(2);
    expect(later.results[0].id).toBe("2");
  });

  test("simultaneous identical searches share one call", async () => {
    const { service, calls } = makeService([page([match(1)])]);
    const [a, b] = await Promise.all([service.search({ matchup: "tvz" }), service.search({ matchup: "tvz" })]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual(b);
  });

  test("calls leave at least a second apart", async () => {
    const { service, sleeps } = makeService([page([]), page([]), page([])]);
    await Promise.all([service.search({ matchup: "tvz" }), service.search({ matchup: "tvp" }), service.search({ matchup: "zvp" })]);
    expect(sleeps).toEqual([PACE_MS, PACE_MS]);
    expect(PACE_MS).toBeGreaterThanOrEqual(1000);
  });

  test("a queue that would wait too long is refused with busy", async () => {
    const { service } = makeService(Array.from({ length: 6 }, () => page([])), { sleep: () => new Promise(() => {}) });
    // The first search leaves at once; each later one waits one more pace.
    ["55370", "55371", "55372", "55373", "55374"].forEach(map => { void service.search({ map }); });
    await expect(service.search({ map: "55375" })).rejects.toMatchObject({ code: "busy" });
  });

  test("a failed refresh serves the last answer for an hour, then fails", async () => {
    const { service, clock } = makeService([page([match(1)]), () => reply({}, 500), () => reply({}, 500)]);
    await service.search({ matchup: "tvz" });
    clock.at += CACHE_TTL_MS + 1;
    const stale = await service.search({ matchup: "tvz" });
    expect(stale.results[0].id).toBe("1");
    clock.at += STALE_LIMIT_MS;
    await expect(service.search({ matchup: "tvz" })).rejects.toMatchObject({ code: "unavailable" });
  });

  test("an upstream failure with nothing earlier is unavailable and is not cached", async () => {
    const { service, calls } = makeService([() => reply({}, 503), page([match(1)])]);
    await expect(service.search({})).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.search({})).resolves.toMatchObject({ available: true });
    expect(calls).toHaveLength(2);
  });

  test("a lookup failure on the channels still lists the games", async () => {
    const resolveChannels = async () => { throw new Error("twitch down"); };
    const { service } = makeService([page([match(1)])], { resolveChannels });
    const answer = await service.search({});
    expect(answer.results).toEqual([expect.objectContaining({ id: "1", channel: null })]);
  });

  test("an invalid search is refused before any call, and an empty page has no next cursor", async () => {
    const { service, fetchImpl } = makeService([page([], "ignored")]);
    await expect(service.search({ map: "9" })).rejects.toMatchObject({ code: "invalid_search" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(service.search({})).resolves.toMatchObject({ results: [], next: null });
  });
});

describe("buildTwitchVideoChannelResolver", () => {
  const credentials = { clientId: "id", clientSecret: "secret", redirectUri: "" };

  function twitchFetch(videoRows) {
    const calls = [];
    const fetchImpl = jest.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      calls.push({ host: parsed.host, ids: parsed.searchParams.getAll("id"), headers: init.headers });
      if (parsed.host === "id.twitch.tv") return reply({ access_token: "tok", expires_in: 5000, token_type: "bearer" });
      const status = typeof videoRows === "number" ? videoRows : 200;
      return reply({ data: typeof videoRows === "number" ? [] : videoRows }, status);
    });
    return { fetchImpl, calls };
  }

  test("names each video's channel in one call and remembers it", async () => {
    const { fetchImpl, calls } = twitchFetch([{ id: "1", user_login: "alpha" }, { id: "2", user_login: "beta" }]);
    const resolve = buildTwitchVideoChannelResolver({ credentials, fetchImpl });
    expect(await resolve(["1", "2", "1", "3"])).toEqual(new Map([["1", "alpha"], ["2", "beta"]]));
    const videoCall = calls.find(call => call.host === "api.twitch.tv");
    expect(videoCall.ids).toEqual(["1", "2", "3"]);
    expect(videoCall.headers).toMatchObject({ "Client-Id": "id", Authorization: "Bearer tok" });
    await resolve(["1", "2"]);
    expect(calls.filter(call => call.host === "api.twitch.tv")).toHaveLength(1);
  });

  test("without credentials it names nothing and calls nothing", async () => {
    const { fetchImpl } = twitchFetch([]);
    const resolve = buildTwitchVideoChannelResolver({ credentials: null, fetchImpl });
    expect(await resolve(["1"])).toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a rejected token is dropped so the next lookup gets a new one", async () => {
    const { fetchImpl, calls } = twitchFetch(401);
    const resolve = buildTwitchVideoChannelResolver({ credentials, fetchImpl });
    await expect(resolve(["1"])).rejects.toThrow();
    await expect(resolve(["1"])).rejects.toThrow();
    expect(calls.filter(call => call.host === "id.twitch.tv")).toHaveLength(2);
  });
});

describe("GET /ladder-vods", () => {
  const appFor = service => {
    const app = express();
    app.use("/v1", buildLadderVodsRouter({ ladderVods: service }));
    return app;
  };

  test("serves a page with cache headers", async () => {
    const { service } = makeService([page([match(1)])]);
    const res = await request(appFor(service)).get("/v1/ladder-vods?matchup=tvz");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/public, max-age=60/);
    expect(res.body.results).toHaveLength(1);
  });

  test("answers available false with the gate off and calls nothing", async () => {
    const { service, fetchImpl } = makeService([], { enabled: false });
    const res = await request(appFor(service)).get("/v1/ladder-vods?matchup=tvz");
    expect(res.body).toEqual({ available: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    [{ matchup: "bad" }, 400, "ladder_vods_invalid_search"],
  ])("maps %j to %i", async (query, status, code) => {
    const { service } = makeService([page([])]);
    const res = await request(appFor(service)).get("/v1/ladder-vods").query(query);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  test("a failed search is a 503 without detail, and busy asks for a retry", async () => {
    const down = makeService([() => reply({}, 500)]);
    const res = await request(appFor(down.service)).get("/v1/ladder-vods");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ladder_vods_unavailable");
    const busy = { search: async () => { const { LadderVodsError } = require("../src/services/ladderVods"); throw new LadderVodsError("busy"); } };
    const wait = await request(appFor(busy)).get("/v1/ladder-vods");
    expect(wait.status).toBe(503);
    expect(wait.headers["retry-after"]).toBe("5");
  });

  test("an unexpected error goes to the error handler", async () => {
    const app = appFor({ search: async () => { throw new Error("boom"); } });
    const res = await request(app).get("/v1/ladder-vods");
    expect(res.status).toBe(500);
  });

  test("refuses a router without a service", () => {
    expect(() => buildLadderVodsRouter({})).toThrow(/service required/);
  });
});

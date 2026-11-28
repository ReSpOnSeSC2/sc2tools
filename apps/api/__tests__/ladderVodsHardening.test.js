// @ts-nocheck
"use strict";

/**
 * Ladder VOD finder limits and edge cases: the Map menu following the live
 * pool, how a visitor's cursor searches share the one-a-second SC2Pulse pace,
 * the cache bounds, the Twitch deadline and retry, the rating band and the
 * public status route.
 */

const express = require("express");
const request = require("supertest");
const { parseSearch, shapeMatch } = require("../src/services/ladderVodSearch");
const { LadderVodsService, MAX_CACHE_ENTRIES, PACE_MS } = require("../src/services/ladderVods");
const { buildMapMenu, plainMapName } = require("../src/services/ladderVodMaps");
const { buildTwitchVideoChannelResolver } = require("../src/services/twitchVideoChannels");
const { buildLadderVodsRouter } = require("../src/routes/ladderVods");

const reply = (body, status = 200) => ({
  ok: status < 400,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => JSON.stringify(body),
  json: async () => body,
});

const side = (rating, race, vod) => ({
  team: { rating, members: [{ raceGames: { [race]: 40 } }] },
  teamState: { teamState: { rating } },
  twitchVodUrl: vod ?? null,
});

const row = (rating, map = { id: 55373, name: "Blackrock LE" }) => ({
  match: { id: 1, date: "2026-11-27T18:18:50Z", duration: 600 },
  map,
  participants: [side(rating, "ZERG", "https://www.twitch.tv/videos/77?t=5s"), side(4000, "TERRAN")],
});

const page = (rows = [], after = "next") => ({ result: rows, navigation: { after } });

function makeService(pages, extra = {}) {
  const clock = { at: 1_000_000 };
  const calls = [];
  const fetchImpl = jest.fn(async (url) => {
    calls.push(new URL(url));
    const next = pages.shift() ?? page();
    return typeof next === "function" ? next() : reply(next);
  });
  const service = new LadderVodsService({
    enabled: true,
    fetchImpl,
    now: () => clock.at,
    sleep: async ms => { clock.at += ms; },
    resolveChannels: async () => new Map(),
    ...extra,
  });
  return { service, clock, calls, fetchImpl };
}

describe("the rating shown stays in the band searched", () => {
  const band = [5000, 5999];
  const tvz = ["TERRAN", "ZERG"];

  test.each([
    [5960, [5000, 5999], 5900],
    [5040, [5000, 5999], 5000],
    [2970, [0, 2999], 2900],
    [6020, [6000, null], 6000],
  ])("%i in %j is shown as %i", (exact, searched, shown) => {
    expect(shapeMatch(row(exact), tvz, searched).rating).toBe(shown);
  });

  test("a rating outside the band (the opponent matched) is only rounded", () => {
    expect(shapeMatch(row(6694), tvz, band).rating).toBe(6700);
    expect(shapeMatch(row(5960), tvz, null).rating).toBe(6000);
  });

  test("a search carries its band to the result", async () => {
    const { service } = makeService([page([row(5960)])]);
    const answer = await service.search({ matchup: "tvz", rating: "5000" });
    expect(answer.results[0].rating).toBe(5900);
  });
});

describe("the Map menu follows the live pool", () => {
  const poolOf = names => ({ get: async () => ({ maps: names }) });

  test("names match with or without LE and CE", () => {
    expect(plainMapName("Blackrock LE")).toBe("Blackrock");
    expect(plainMapName("Fields of Death CE")).toBe("Fields of Death");
    expect(plainMapName("Rainfall")).toBe("Rainfall");
  });

  test("a retired map leaves the menu and its id is refused", async () => {
    const { service, fetchImpl } = makeService([page()], { mapPool: poolOf(["Lockdown", "Blackrock"]) });
    await expect(service.search({ map: "55377" })).rejects.toMatchObject({ code: "invalid_search" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const answer = await service.search({ map: "55373" });
    expect(answer.maps).toEqual([{ id: "55373", name: "Blackrock" }, { id: "55370", name: "Lockdown" }]);
  });

  test("a new map joins the menu once the match feed shows it", async () => {
    const pool = poolOf(["Lockdown", "Blackrock", "Newmap"]);
    const { service } = makeService([page([row(5000, { id: 55400, name: "Newmap LE" })])], { mapPool: pool });
    await expect(service.search({ map: "55400" })).rejects.toMatchObject({ code: "invalid_search" });
    const first = await service.search({});
    expect(first.maps.map(entry => entry.name)).toEqual(["Blackrock", "Lockdown"]);
    const later = await service.search({ map: "55400" });
    expect(later.maps).toContainEqual({ id: "55400", name: "Newmap" });
  });

  test("a pool that cannot be read or names none of the maps keeps every known map", async () => {
    const down = makeService([page()], { mapPool: { get: async () => { throw new Error("liquipedia down"); } } });
    expect((await down.service.search({})).maps).toHaveLength(9);
    expect(buildMapMenu(new Map(), ["Unrelated"])).toHaveLength(9);
    expect(buildMapMenu(new Map(), [])).toHaveLength(9);
  });

  test("parseSearch accepts only the maps on offer", () => {
    const maps = [{ id: 7, name: "Seven" }];
    expect(parseSearch({ map: "7" }, maps).query.get("mapId")).toBe("7");
    expect(parseSearch({ map: "55373" }, maps)).toBeNull();
  });
});

describe("cursor searches cannot fill the queue", () => {
  test("a later page may only take the next free slot, and first pages are not crowded out", async () => {
    const { service } = makeService([], { sleep: () => new Promise(() => {}) });
    void service.search({ matchup: "tvz" });
    void service.search({ matchup: "tvz", after: "aaa" });
    await expect(service.search({ matchup: "tvz", after: "bbb" })).rejects.toMatchObject({ code: "busy" });
    void service.search({ matchup: "tvp" });
    await new Promise(resolve => setImmediate(resolve));
    expect(service.pulse.nextCallAt - service.now()).toBe(PACE_MS * 3);
  });
});

describe("cache bounds", () => {
  test("distinct cursors cannot grow the cache past its limit or push out first pages", async () => {
    const { service, calls } = makeService([]);
    await service.search({ matchup: "tvz" });
    for (let index = 0; index < MAX_CACHE_ENTRIES + 20; index += 1) {
      await service.search({ matchup: "tvz", after: `cursor${index}` });
    }
    expect(service.cache.size).toBe(MAX_CACHE_ENTRIES);
    const before = calls.length;
    await service.search({ matchup: "tvz" });
    expect(calls).toHaveLength(before);
  });

  test("with only first pages the oldest search is dropped", async () => {
    const { service } = makeService([]);
    const maps = ["55370", "55371", "55372", "55373", "55374", "55375", "55376", "55377", "55378"];
    const searches = [];
    for (const matchup of ["tvz", "tvp", "zvp", "tvt", "zvz", "pvp"]) {
      for (const rating of ["0", "3000", "4000", "5000", "6000"]) {
        for (const map of maps) searches.push({ matchup, rating, map });
      }
    }
    const many = searches.slice(0, MAX_CACHE_ENTRIES + 5);
    expect(many.length).toBe(MAX_CACHE_ENTRIES + 5);
    for (const input of many) await service.search(input);
    expect(service.cache.size).toBe(MAX_CACHE_ENTRIES);
    expect(service.cache.has(parseSearch(many[0]).key)).toBe(false);
    expect(service.cache.has(parseSearch(many[many.length - 1]).key)).toBe(true);
  });
});

describe("the Twitch channel lookup", () => {
  test("a lookup that hangs does not hold the games back", async () => {
    const { service } = makeService([page([row(5000)])], { resolveChannels: () => new Promise(() => {}), channelDeadlineMs: 20 });
    const answer = await service.search({});
    expect(answer.results).toHaveLength(1);
    expect(answer.results[0].channel).toBeNull();
  });

  const credentials = { clientId: "id", clientSecret: "secret", redirectUri: "" };

  function twitch(statuses) {
    const calls = [];
    const fetchImpl = jest.fn(async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.host === "id.twitch.tv") return reply({ access_token: `tok${calls.length}`, expires_in: 5000, token_type: "bearer" });
      const status = statuses.shift() ?? 200;
      const ids = parsed.searchParams.getAll("id");
      return reply({ data: status === 200 ? ids.map(id => ({ id, user_login: `chan${id}` })) : [] }, status);
    });
    return { fetchImpl, calls };
  }

  test("a revoked token is replaced and the lookup repeated once", async () => {
    const { fetchImpl, calls } = twitch([401, 200]);
    const resolve = buildTwitchVideoChannelResolver({ credentials, fetchImpl });
    expect(await resolve(["5"])).toEqual(new Map([["5", "chan5"]]));
    expect(calls.filter(call => call.host === "id.twitch.tv")).toHaveLength(2);
    const stuck = twitch([401, 401]);
    await expect(buildTwitchVideoChannelResolver({ credentials, fetchImpl: stuck.fetchImpl })(["6"])).rejects.toThrow();
  });

  test("the channels it remembers stay bounded", async () => {
    const { fetchImpl, calls } = twitch([]);
    const resolve = buildTwitchVideoChannelResolver({ credentials, fetchImpl });
    for (let batch = 0; batch < 51; batch += 1) {
      await resolve(Array.from({ length: 100 }, (_, index) => String(batch * 100 + index)));
    }
    const lookups = () => calls.filter(call => call.host === "api.twitch.tv").length;
    const before = lookups();
    await resolve(["0"]);
    expect(lookups()).toBe(before + 1);
    await resolve(["5099"]);
    expect(lookups()).toBe(before + 1);
  });
});

describe("the public routes", () => {
  const appFor = service => {
    const app = express();
    app.set("trust proxy", false);
    app.use("/v1", buildLadderVodsRouter({ ladderVods: service }));
    return app;
  };

  test("status says whether the gate is open and calls nothing", async () => {
    const closed = makeService([], { enabled: false });
    const open = makeService([]);
    expect((await request(appFor(closed.service)).get("/v1/ladder-vods/status")).body).toEqual({ available: false });
    const res = await request(appFor(open.service)).get("/v1/ladder-vods/status");
    expect(res.body).toEqual({ available: true });
    expect(res.headers["cache-control"]).toMatch(/public/);
    expect(closed.fetchImpl).not.toHaveBeenCalled();
    expect(open.fetchImpl).not.toHaveBeenCalled();
  });

  test("a visitor gets 20 searches a minute, well under the server's SC2Pulse budget", async () => {
    const { service } = makeService([], { enabled: false });
    const app = appFor(service);
    const statuses = [];
    for (let index = 0; index < 21; index += 1) statuses.push((await request(app).get("/v1/ladder-vods")).status);
    expect(statuses.slice(0, 20).every(status => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

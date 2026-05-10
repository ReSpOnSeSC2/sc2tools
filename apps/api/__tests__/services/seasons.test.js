"use strict";

const { SeasonsService } = require("../../src/services/seasons");

class FakeMapPool {
  constructor(maps) {
    this.maps = maps;
  }
  async get() {
    return { maps: this.maps.slice(), source: "liquipedia", fetchedAt: 1 };
  }
  async refresh() {
    return { maps: this.maps.slice(), added: [], removed: [], source: "liquipedia" };
  }
}

const SAMPLE_PULSE_RESPONSE = [
  {
    battlenetId: 60,
    region: "US",
    year: 2026,
    number: 60,
    start: "2026-04-01",
    end: "2026-06-01",
  },
];

function pulseResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

describe("SeasonsService.list — mapPool wiring", () => {
  test("payload.mapPool comes from the injected LadderMapPoolService", async () => {
    const fetchImpl = jest.fn(async () => pulseResponse(SAMPLE_PULSE_RESPONSE));
    const svc = new SeasonsService({
      fetchImpl,
      ladderMapPool: new FakeMapPool(["Atlas", "Border"]),
    });
    const out = await svc.list();
    expect(out.mapPool).toEqual(["Atlas", "Border"]);
    expect(out.items.length).toBe(1);
    expect(out.current).toBe(60);
  });

  test("mapPool degrades to the baked-in FALLBACK_POOL when the service throws", async () => {
    const fetchImpl = jest.fn(async () => pulseResponse(SAMPLE_PULSE_RESPONSE));
    const explodingPool = {
      async get() {
        throw new Error("kaboom");
      },
    };
    const svc = new SeasonsService({
      fetchImpl,
      ladderMapPool: explodingPool,
    });
    const out = await svc.list();
    expect(Array.isArray(out.mapPool)).toBe(true);
    expect(out.mapPool.length).toBeGreaterThan(0); // baked fallback present
  });

  test("returns mapPool even when SC2Pulse season fetch fails", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("network");
    });
    const svc = new SeasonsService({
      fetchImpl,
      ladderMapPool: new FakeMapPool(["OnlyMap"]),
    });
    const out = await svc.list();
    expect(out.items).toEqual([]);
    expect(out.source).toBe("fallback");
    expect(out.mapPool).toEqual(["OnlyMap"]);
  });
});

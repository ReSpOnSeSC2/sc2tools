// @ts-nocheck
"use strict";

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { regionFromToonHandleExpr } = require("../src/services/trendsRegionExpr");
const {
  regionFromToonHandle,
  REGION_HANDLE_PREFIX,
  REGION_LABELS,
} = require("../src/util/regionFromToonHandle");

// eslint-disable-next-line max-lines-per-function
describe("services/trendsRegionExpr.regionFromToonHandleExpr", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "trends_region_expr_test" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  beforeEach(async () => {
    await db.games.deleteMany({});
  });

  /** Evaluate the expression server-side against one row per handle. */
  async function regionsFor(handles) {
    await db.games.insertMany(
      handles.map((handle, i) => {
        const doc = { userId: "u1", gameId: `g${i}`, order: i };
        if (handle !== undefined) doc.myToonHandle = handle;
        return doc;
      }),
    );
    const rows = await db.games
      .aggregate([
        { $match: { userId: "u1" } },
        { $sort: { order: 1 } },
        {
          $project: {
            _id: 0,
            region: regionFromToonHandleExpr("$myToonHandle"),
          },
        },
      ])
      .toArray();
    return rows.map((row) => row.region);
  }

  test("labels each region by the segment before the first dash", async () => {
    expect(
      await regionsFor([
        "1-S2-1-12345",
        "2-S2-1-12345",
        "3-S2-1-12345",
        "5-S2-1-12345",
        "6-S2-1-12345",
        "98-S2-1-30230",
      ]),
    ).toEqual(["NA", "EU", "KR", "CN", "SEA", "PTR"]);
  });

  test("near-miss, malformed and missing handles fall into U", async () => {
    expect(
      await regionsFor([
        "9-S2-1-1",
        "981-S2-1-1",
        "12-S2-1-1",
        "4-S2-1-1",
        "",
        "   ",
        "constructor-S2-1-1",
        null,
        undefined,
        98,
      ]),
    ).toEqual(["U", "U", "U", "U", "U", "U", "U", "U", "U", "U"]);
  });

  test("agrees with the JS helper for every label", async () => {
    const handles = REGION_LABELS.map(
      (label) => `${REGION_HANDLE_PREFIX[label]}-S2-1-777`,
    );
    const fromMongo = await regionsFor(handles);
    expect(fromMongo).toEqual(handles.map((h) => regionFromToonHandle(h)));
    expect(fromMongo).toEqual([...REGION_LABELS]);
  });

  test("stays a pure expression with a U default", () => {
    const expr = regionFromToonHandleExpr("$opponent.toonHandle");
    expect(expr.$let.in.$switch.default).toBe("U");
    expect(expr.$let.in.$switch.branches).toContainEqual({
      case: { $eq: ["$$head", "98"] },
      then: "PTR",
    });
    // Two calls never share mutable state.
    expect(regionFromToonHandleExpr("$opponent.toonHandle")).toEqual(expr);
    expect(regionFromToonHandleExpr("$opponent.toonHandle")).not.toBe(expr);
  });
});

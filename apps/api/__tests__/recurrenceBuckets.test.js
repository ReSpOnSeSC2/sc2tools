// @ts-nocheck
"use strict";

/**
 * util/recurrenceBuckets.js — the bucket math coaching assignments and
 * personal goals share:
 *   1. local windows and buckets are DST-correct (23/25-hour days, a
 *      167-hour week, a zone that skips midnight);
 *   2. the keys of a real ``$dateTrunc`` group (recurrenceGroupExpression)
 *      resolve through bucketKeyFor to exactly the buckets
 *      recurrenceBuckets expands, across DST, in Mongo itself;
 *   3. malformed dates fail with "bad_date".
 */

const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const {
  localWindow,
  parsePlainDate,
  recurrenceBuckets,
  recurrenceGroupExpression,
  bucketKeyFor,
  zonedLocalToUtc,
} = require("../src/util/recurrenceBuckets");

const HOUR = 3_600_000;

/** @param {string} startsOn @param {string} endsOn @param {string} tz @param {string} recurrence */
function requirement(startsOn, endsOn, tz, recurrence) {
  const bounds = localWindow(parsePlainDate(startsOn, "startsOn"), parsePlainDate(endsOn, "endsOn"), tz);
  return { recurrence, timeZone: tz, startsOn, endsOn, ...bounds };
}

function hours(bucket) {
  return (Date.parse(bucket.endsAt) - Date.parse(bucket.startsAt)) / HOUR;
}

describe("recurrence bucket math", () => {
  test("daily buckets keep local midnights across both DST changes", () => {
    const spring = recurrenceBuckets(requirement("2026-03-07", "2026-03-09", "America/New_York", "daily"));
    expect(spring.map((b) => b.key)).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
    expect(spring.map(hours)).toEqual([24, 23, 24]);
    expect(spring[1].startsAt).toBe("2026-03-08T05:00:00.000Z");
    const fall = recurrenceBuckets(requirement("2026-11-01", "2026-11-01", "America/New_York", "daily"));
    expect(fall.map(hours)).toEqual([25]);
  });

  test("weekly buckets start on local Mondays, clip to the window and span DST", () => {
    const weeks = recurrenceBuckets(requirement("2026-03-04", "2026-03-15", "America/New_York", "weekly"));
    expect(weeks.map((b) => b.key)).toEqual(["2026-03-02", "2026-03-09"]);
    // Clipped to the window start (Wednesday); its Sunday is the 23 h DST day.
    expect(weeks[0].startsAt).toBe("2026-03-04T05:00:00.000Z");
    expect(hours(weeks[0])).toBe(5 * 24 - 1);
    expect(weeks[1].startsAt).toBe("2026-03-09T04:00:00.000Z");
    expect(hours(weeks[1])).toBe(7 * 24);
    const dstWeek = recurrenceBuckets(requirement("2026-03-02", "2026-03-08", "America/New_York", "weekly"));
    expect(hours(dstWeek[0])).toBe(7 * 24 - 1);
  });

  test("monthly keys are local months; once is one bucket", () => {
    const months = recurrenceBuckets(requirement("2026-10-15", "2026-12-02", "Europe/London", "monthly"));
    expect(months.map((b) => b.key)).toEqual(["2026-10", "2026-11", "2026-12"]);
    // October ends on the local midnight after the clocks went back.
    expect(months[0].endsAt).toBe("2026-11-01T00:00:00.000Z");
    const once = recurrenceBuckets(requirement("2026-10-15", "2026-12-02", "Europe/London", "once"));
    expect(once).toEqual([{ key: "once", startsAt: "2026-10-14T23:00:00.000Z", endsAt: "2026-12-03T00:00:00.000Z" }]);
  });

  test("a zone that skips midnight resolves to the first valid local instant", () => {
    // Chile moved clocks forward at 00:00 on 2026-09-06: midnight never happened.
    expect(zonedLocalToUtc(2026, 9, 6, 0, "America/Santiago")).toBeNull();
    const skipped = zonedLocalToUtc(2026, 9, 6, 0, "America/Santiago", true);
    expect(skipped.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    const days = recurrenceBuckets(requirement("2026-09-05", "2026-09-06", "America/Santiago", "daily"));
    // Sept 5 is a full 24 h day at UTC-4; Sept 6 starts at 01:00 (UTC-3).
    expect(days.map(hours)).toEqual([24, 23]);
  });

  test("malformed dates fail as bad_date", () => {
    expect(() => parsePlainDate("2026-02-30", "startsOn")).toThrow(expect.objectContaining({ reason: "bad_date", message: "startsOn is not a valid calendar date." }));
    expect(() => recurrenceBuckets({ recurrence: "daily", timeZone: "UTC", startsOn: "nope", endsOn: "2026-01-01" }))
      .toThrow(expect.objectContaining({ reason: "bad_date" }));
  });
});

describe("Mongo $dateTrunc groups join the expanded buckets", () => {
  let mongo;
  let client;
  let coll;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: "7.0.14" } });
    client = await MongoClient.connect(mongo.getUri());
    coll = client.db("recurrence_buckets").collection("rows");
  });
  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  });

  test.each([
    ["daily", "America/New_York", "2026-03-06", "2026-03-10"],
    ["weekly", "America/New_York", "2026-02-25", "2026-03-20"],
    ["monthly", "Europe/London", "2026-09-20", "2026-12-05"],
    ["daily", "America/Santiago", "2026-09-04", "2026-09-08"],
  ])("%s in %s", async (recurrence, tz, startsOn, endsOn) => {
    const req = requirement(startsOn, endsOn, tz, recurrence);
    const buckets = recurrenceBuckets(req);
    await coll.deleteMany({});
    // One row one minute inside each bucket's edges.
    await coll.insertMany(buckets.flatMap((bucket) => [
      { date: new Date(Date.parse(bucket.startsAt) + 60_000), key: bucket.key },
      { date: new Date(Date.parse(bucket.endsAt) - 60_000), key: bucket.key },
    ]));
    const groups = await coll.aggregate([
      { $group: { _id: recurrenceGroupExpression(req, "$date"), keys: { $addToSet: "$key" }, n: { $sum: 1 } } },
    ]).toArray();
    expect(groups).toHaveLength(buckets.length);
    for (const group of groups) {
      expect(group.keys).toEqual([bucketKeyFor(req, group._id)]);
      expect(group.n).toBe(2);
    }
  });
});

// @ts-nocheck
"use strict";

/**
 * The bucket-width contract behind the "Win rate by opponent MMR"
 * card: which widths exist, and how a raw ``bucket_width`` query
 * param is narrowed to one of them before it reaches the aggregation.
 *
 * Pipeline behaviour per width lives in ``aggregations.test.js``;
 * this file guards the seam between the URL and the service, which is
 * where a new bracket size is most likely to be half-wired — offered
 * by the UI, silently discarded by the parser.
 */

const express = require("express");
const request = require("supertest");

const {
  asOppMmrBucketWidth,
  OPP_MMR_BUCKET_WIDTHS,
} = require("../src/services/trendsOppMmr");
const { buildAggregationsRouter } = require("../src/routes/aggregations");

/**
 * Mount only the aggregations router over a stub service, so the
 * width parsing can be exercised over real HTTP without a database.
 */
function mountRouter() {
  const calls = [];
  const app = express();
  app.use(
    "/v1",
    buildAggregationsRouter({
      auth: (req, _res, next) => {
        req.auth = { userId: "u1" };
        next();
      },
      aggregations: {
        async oppMmrBuckets(userId, filters, opts) {
          calls.push({ userId, filters, opts });
          return {
            bucketWidth: opts.bucketWidth,
            buckets: [],
            unknown: { total: 0, wins: 0, losses: 0 },
          };
        },
      },
      macroReport: {},
      streak: {},
    }),
  );
  return { app, calls };
}

describe("opponent-MMR bucket widths", () => {
  test("the offered widths are 50, 100 and 500, narrowest first", () => {
    // The client mirrors this list in OppMmrBucketsChart.tsx and the
    // server rejects everything else back to "auto", so the order and
    // membership here are the contract both sides read.
    expect([...OPP_MMR_BUCKET_WIDTHS]).toEqual([50, 100, 500]);
  });

  test("asOppMmrBucketWidth accepts every offered width, as number or text", () => {
    for (const width of OPP_MMR_BUCKET_WIDTHS) {
      expect(asOppMmrBucketWidth(width)).toBe(width);
      expect(asOppMmrBucketWidth(String(width))).toBe(width);
      expect(asOppMmrBucketWidth(` ${width} `)).toBe(width);
    }
  });

  test("asOppMmrBucketWidth rejects anything else to null", () => {
    // null is the "no opinion" answer callers turn into their own
    // default — never a thrown error, because bucket_width is a
    // cosmetic parameter and a typo should not 500 the chart.
    for (const raw of [
      "auto",
      "",
      "  ",
      null,
      undefined,
      0,
      25,
      250,
      1000,
      -500,
      "500px",
      "abc",
      true,
      [],
      ["50", "100"],
      {},
      NaN,
      Infinity,
    ]) {
      expect(asOppMmrBucketWidth(raw)).toBeNull();
    }
  });

  describe("GET /v1/opp-mmr-buckets", () => {
    test("forwards each offered width through to the aggregation", async () => {
      for (const width of OPP_MMR_BUCKET_WIDTHS) {
        const { app, calls } = mountRouter();
        const res = await request(app).get(
          `/v1/opp-mmr-buckets?bucket_width=${width}`,
        );
        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].opts).toEqual({ bucketWidth: width });
        expect(res.body.bucketWidth).toBe(width);
      }
    });

    test("falls back to auto when the width is absent, literal, or unsupported", async () => {
      for (const query of [
        "",
        "?bucket_width=auto",
        "?bucket_width=",
        "?bucket_width=250",
        "?bucket_width=nonsense",
      ]) {
        const { app, calls } = mountRouter();
        const res = await request(app).get(`/v1/opp-mmr-buckets${query}`);
        expect(res.status).toBe(200);
        expect(calls[0].opts).toEqual({ bucketWidth: "auto" });
      }
    });

    test("passes the global filter set alongside the width", async () => {
      // The width must not displace the filters — the histogram and
      // its drilldown both have to answer for the same cohort.
      const { app, calls } = mountRouter();
      const res = await request(app).get(
        "/v1/opp-mmr-buckets?bucket_width=500&race=P&opp_race=Z",
      );
      expect(res.status).toBe(200);
      expect(calls[0].userId).toBe("u1");
      expect(calls[0].filters).toMatchObject({ race: "P", oppRace: "Z" });
      expect(calls[0].opts).toEqual({ bucketWidth: 500 });
    });
  });
});

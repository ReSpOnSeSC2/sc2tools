// @ts-nocheck
"use strict";

const express = require("express");
const request = require("supertest");
const { buildReviewsRouter } = require("../src/routes/reviews");

const ID = "abcdefghijklmnop";
const READ_ROUTES = [
  ["/reviews", "public, max-age=0, s-maxage=60"],
  ["/reviews/leaderboard", "public, max-age=0, s-maxage=60"],
  ["/reviews/sitemap", "public, max-age=0, s-maxage=300"],
  [`/reviews/${ID}`, "public, max-age=0, s-maxage=30"],
  [`/reviews/${ID}/og`, "public, max-age=0, s-maxage=300"],
  [`/reviews/${ID}/analysis`, "public, max-age=60, s-maxage=60"],
  [`/reviews/${ID}/analysis/map-playback`, "public, max-age=60, s-maxage=60"],
  [`/reviews/${ID}/analysis/map-playback/manifest`, "public, max-age=60, s-maxage=60"],
  [`/reviews/${ID}/analysis/map-playback/artifacts/${"a".repeat(64)}/segments/0`, "private, max-age=3600"],
];

function fixture(rollout) {
  const reviews = {
    board: jest.fn(async () => ({ items: [], nextCursor: null })),
    sitemap: jest.fn(async () => ({ items: [] })),
    page: jest.fn(async () => ({ request: { id: ID }, comments: [], viewer: {}, seo: {} })),
    ogSummary: jest.fn(async () => ({ id: ID })),
    analysis: jest.fn(async () => ({ requestId: ID })),
    playback: jest.fn(async () => ({ v: 5 })),
    playbackManifest: jest.fn(async () => ({ artifactId: "a".repeat(64) })),
    playbackSegment: jest.fn(async () => Buffer.from('{"v":5}')),
  };
  const reputation = { weeklyLeaderboard: jest.fn(async () => ({ items: [] })) };
  const app = express();
  app.use("/v1", buildReviewsRouter({
    reviews, reputation, rollout,
    auth: (req, _res, next) => {
      const token = req.get("authorization");
      if (token) req.auth = {
        userId: token === "Bearer boss" ? "u_boss" : "u_regular",
        clerkUserId: token === "Bearer boss" ? "clerk_boss" : "clerk_regular",
        source: "clerk",
      };
      next();
    },
    isAdmin: (req) => req.auth?.clerkUserId === "clerk_boss",
  }));
  return { app, reviews, reputation };
}

describe("reviews: rollout cache policy", () => {
  test.each(READ_ROUTES)("admin-only %s is never stored in browsers or shared caches", async (path) => {
    const { app } = fixture("admins");
    const response = await request(app).get(`/v1${path}`).set("authorization", "Bearer boss");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  test.each(READ_ROUTES)("admin-only %s still refuses anonymous and ordinary viewers", async (path) => {
    const { app, reviews, reputation } = fixture("admins");
    for (const token of [null, "Bearer regular"]) {
      const probe = request(app).get(`/v1${path}`);
      if (token) probe.set("authorization", token);
      const response = await probe;
      expect(response.status).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    for (const fn of [...Object.values(reviews), ...Object.values(reputation)]) expect(fn).not.toHaveBeenCalled();
  });

  test.each(READ_ROUTES)("public %s retains its intended cache policy", async (path, cacheControl) => {
    const { app } = fixture("on");
    const response = await request(app).get(`/v1${path}`);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe(cacheControl);
  });
});

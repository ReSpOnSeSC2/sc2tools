// @ts-nocheck
"use strict";

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const { buildMapImageRouter } = require("../src/routes/mapImage");

describe("public map image route", () => {
  let dir;
  let imagePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc2-map-route-"));
    imagePath = path.join(dir, "map.webp");
    fs.writeFileSync(imagePath, Buffer.from("REAL-WEBP-BYTES"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function appFor(found) {
    const app = express();
    app.use(
      "/v1",
      buildMapImageRouter({ catalog: { mapImagePath: () => found } }),
    );
    return app;
  }

  test("streams optimized bytes with a durable public cache and ETag", async () => {
    const etag = `"${"b".repeat(64)}"`;
    const res = await request(
      appFor({ path: imagePath, contentType: "image/webp", etag }),
    ).get("/v1/map-image?map=Ruby%20Rock");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/webp");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["cache-control"]).toContain("max-age=604800");
    expect(res.headers.etag).toBe(etag);
    expect(Buffer.from(res.body).toString()).toBe("REAL-WEBP-BYTES");
  });

  test("forwards variant=layout to the catalog resolver and ignores junk variants", async () => {
    const seen = [];
    const app = express();
    app.use(
      "/v1",
      buildMapImageRouter({
        catalog: {
          mapImagePath: (name, opts) => {
            seen.push([name, opts]);
            return { path: imagePath, contentType: "image/jpeg" };
          },
        },
      }),
    );

    await request(app).get("/v1/map-image?map=Alcyone%20LE&variant=layout");
    await request(app).get("/v1/map-image?map=Alcyone%20LE&variant=banner");
    await request(app).get("/v1/map-image?map=Alcyone%20LE");

    expect(seen).toEqual([
      ["Alcyone LE", { variant: "layout" }],
      ["Alcyone LE", { variant: undefined }],
      ["Alcyone LE", { variant: undefined }],
    ]);
  });

  test("returns 304 without opening the image when the ETag matches", async () => {
    const etag = `"${"c".repeat(64)}"`;
    const res = await request(
      appFor({ path: imagePath, contentType: "image/webp", etag }),
    )
      .get("/v1/map-image?map=Ruby%20Rock")
      .set("if-none-match", etag);

    expect(res.status).toBe(304);
    expect(res.body).toHaveLength(0);
  });
});

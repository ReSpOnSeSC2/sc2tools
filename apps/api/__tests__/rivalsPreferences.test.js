// @ts-nocheck
"use strict";
const express = require("express"), request = require("supertest");
const { sanitizeRivals, MAX_RIVALS } = require("../src/util/rivalsPreferences");
const { buildMeRouter } = require("../src/routes/me");

describe("bounded rival preferences", () => {
  test("preserves opaque grouped identity keys/order, removes duplicates, and accepts50", () => {
    expect(sanitizeRivals({ keys: ["acct:12", "pro:42", "acct:12", "solo:1-S2-1-123"] }, true)).toEqual({ keys: ["acct:12", "pro:42", "solo:1-S2-1-123"] });
    expect(sanitizeRivals({ keys: Array.from({length:MAX_RIVALS},(_,i) => `acct:${i}`) }, true).keys).toHaveLength(50);
  });
  test.each([null, [], { keys: "acct:1" }, { keys: [""] }, { keys: [" acct:1"] }, { keys: ["a\u0000b"] }, { keys: ["x".repeat(321)] }, { keys: Array.from({length:51},(_,i) => String(i)) }, { keys: [], userId: "other" }])("invalid saved values fail softly but writes reject: %j", value => {
    expect(sanitizeRivals(value)).toEqual({ keys: [] }); expect(() => sanitizeRivals(value,true)).toThrow();
  });
});

function fixture() {
  const values = new Map([['owner-a', { keys: ["acct:1"] }],['owner-b', { keys: ["acct:2"] }]]);
  const users = { getPreferences: jest.fn(async id => values.get(id)), updatePreferences: jest.fn(async (id,_kind,body) => { values.set(id,body); return body; }) };
  const app = express(); app.use(express.json());
  app.use("/v1", buildMeRouter({ users, auth: (req,res,next) => { const owner=req.get("authorization"); if (!owner) return res.sendStatus(401); req.auth={userId:owner}; next(); } }));
  app.use((err,_req,res,_next) => res.status(err.status || 500).json({error:{code:err.code}}));
  return { app, users, values };
}

describe("owner-isolated rival preference route", () => {
  test("reads and writes only the authenticated owner, with private no-store", async () => {
    const { app, values, users } = fixture();
    const read = await request(app).get("/v1/me/preferences/rivals").set("Authorization","owner-a");
    expect(read.status).toBe(200); expect(read.body).toEqual({keys:["acct:1"]}); expect(read.headers['cache-control']).toBe('private, no-store');
    const write = await request(app).put("/v1/me/preferences/rivals").set("Authorization","owner-a").send({keys:["pro:8"]});
    expect(write.status).toBe(200); expect(values.get("owner-b")).toEqual({keys:["acct:2"]});
    expect(users.updatePreferences).toHaveBeenCalledWith("owner-a","rivals",{keys:["pro:8"]});
    expect((await request(app).get("/v1/me/preferences/rivals")).status).toBe(401);
  });
  test("unbounded or malformed writes cannot replace saved stars", async () => {
    const {app,users}=fixture(); const res=await request(app).put("/v1/me/preferences/rivals").set("Authorization","owner-a").send({keys:[" bad"]});
    expect(res.status).toBe(400); expect(res.body.error.code).toBe("invalid_rivals"); expect(users.updatePreferences).not.toHaveBeenCalled();
  });
});

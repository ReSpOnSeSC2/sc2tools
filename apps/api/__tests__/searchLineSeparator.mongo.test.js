// @ts-nocheck
"use strict";

const { MongoClient } = require("mongodb");
const { MongoMemoryServer } = require("mongodb-memory-server");
const searchQuery = require("../src/services/privateSearchQuery");

// A JavaScript RegExp reaches the server as its `source`, which spells the line
// separator U+2028 as a backslash-u escape that the server's PCRE rejects.
// Private search's prefix must arrive as written.
const SEPARATOR = String.fromCharCode(0x2028);

describe("private search prefix with a line separator", () => {
  let mongo, client;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
  });
  afterAll(async () => {
    if (client) await client.close();
    if (mongo) await mongo.stop();
  });

  test("matches the literal separator instead of failing on the server", async () => {
    const query = `Pro${SEPARATOR}Gamer`;
    // The prefix sits in the opponents facet's own $match.
    const match = searchQuery.opponents("owner", query).pipeline.find(stage => stage.$facet).$facet.rows
      .map(stage => stage.$match?.displayNameSample).find(Boolean);
    expect(match.pattern).toBe(`^${query}`);
    const names = client.db("sc2tools_test_line_separator").collection("names");
    await names.insertMany([{ displayNameSample: `${query} two` }, { displayNameSample: "Pro Gamer" }]);
    const found = await names.find({ displayNameSample: match }).toArray();
    expect(found.map(row => row.displayNameSample)).toEqual([`${query} two`]);
  });
});

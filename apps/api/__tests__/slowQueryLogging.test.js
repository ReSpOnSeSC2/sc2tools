// @ts-nocheck
"use strict";

/**
 * Slow-query logging via driver command monitoring. The listener is
 * pure event plumbing, so it's exercised against a bare EventEmitter
 * standing in for the MongoClient.
 */

const { EventEmitter } = require("events");
const { attachSlowQueryLogging } = require("../src/db/connect");

function makeLogger() {
  const warns = [];
  return {
    warns,
    warn: (fields, msg) => warns.push({ fields, msg }),
  };
}

describe("attachSlowQueryLogging", () => {
  test("logs commands over the threshold with name + collection", () => {
    const client = new EventEmitter();
    const logger = makeLogger();
    attachSlowQueryLogging(client, logger, 100);

    client.emit("commandStarted", {
      requestId: 1,
      commandName: "aggregate",
      command: { aggregate: "games", pipeline: [] },
    });
    client.emit("commandSucceeded", {
      requestId: 1,
      commandName: "aggregate",
      duration: 250.4,
    });

    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0].msg).toBe("slow_query");
    expect(logger.warns[0].fields).toEqual({
      commandName: "aggregate",
      collection: "games",
      durationMs: 250,
    });
  });

  test("fast commands and pool chatter stay quiet", () => {
    const client = new EventEmitter();
    const logger = makeLogger();
    attachSlowQueryLogging(client, logger, 100);

    // Fast query: under threshold.
    client.emit("commandStarted", {
      requestId: 2,
      commandName: "find",
      command: { find: "games" },
    });
    client.emit("commandSucceeded", {
      requestId: 2,
      commandName: "find",
      duration: 12,
    });
    // Heartbeat chatter: ignored regardless of duration.
    client.emit("commandStarted", {
      requestId: 3,
      commandName: "ping",
      command: { ping: 1 },
    });
    client.emit("commandSucceeded", {
      requestId: 3,
      commandName: "ping",
      duration: 5000,
    });

    expect(logger.warns).toHaveLength(0);
  });

  test("failed commands log with the failure message", () => {
    const client = new EventEmitter();
    const logger = makeLogger();
    attachSlowQueryLogging(client, logger, 100);

    client.emit("commandStarted", {
      requestId: 4,
      commandName: "update",
      command: { update: "games" },
    });
    client.emit("commandFailed", {
      requestId: 4,
      commandName: "update",
      duration: 30,
      failure: new Error("not writable"),
    });

    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0].msg).toBe("mongo_command_failed");
    expect(logger.warns[0].fields.collection).toBe("games");
    expect(logger.warns[0].fields.err).toContain("not writable");
  });

  test("requestId → collection map is bounded", () => {
    const client = new EventEmitter();
    const logger = makeLogger();
    attachSlowQueryLogging(client, logger, 100);
    // Orphaned starts (no terminal event) must not grow unbounded.
    for (let i = 0; i < 1500; i++) {
      client.emit("commandStarted", {
        requestId: i,
        commandName: "find",
        command: { find: "games" },
      });
    }
    // The earliest entries were evicted; a terminal event for one of
    // them simply logs without a collection — no throw, no leak.
    client.emit("commandSucceeded", {
      requestId: 0,
      commandName: "find",
      duration: 500,
    });
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0].fields.collection).toBeUndefined();
  });
});

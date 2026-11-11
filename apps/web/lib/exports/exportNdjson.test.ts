import { describe, expect, it } from "vitest";
import { TextEncoder } from "node:util";
import { ExportNdjson } from "./exportNdjson";

const encode = new TextEncoder();
const lines = (...rows: unknown[]) => encode.encode(rows.map(row => JSON.stringify(row) + "\n").join(""));
const header = { type: "metadata", format: "sc2tools-account-export", version: 1, userId: "owner-a" };
const user = { type: "user", row: null };

describe("completed private export streams", () => {
  it("reconciles declared account collections and UTF-8 split across byte boundaries", () => {
    const parser = new ExportNdjson({ format: "sc2tools-account-export", apiOwner: "owner-a" });
    const bytes = lines(header, { type: "collection", name: "games" },
      { type: "record", collection: "games", row: { unit: "戦闘" } }, user, { type: "complete", counts: { games: 1 } });
    for (let at = 0; at < bytes.length; at++) parser.push(bytes.subarray(at, at + 1));
    expect(() => parser.finish()).not.toThrow();
  });

  it.each([
    ["wrong owner", [{ ...header, userId: "owner-b" }, user, { type: "complete", counts: {} }]],
    ["backup format", [{ ...header, format: "sc2tools-backup" }, user, { type: "complete", counts: {} }]],
    ["missing completion", [header, user]],
    ["missing user", [header, { type: "complete", counts: {} }]],
    ["undeclared rows", [header, { type: "record", collection: "games", row: {} }, user, { type: "complete", counts: {} }]],
    ["incorrect totals", [header, { type: "collection", name: "games" }, user, { type: "complete", counts: { games: 1 } }]],
    ["extra totals", [header, user, { type: "complete", counts: { games: 0 } }]],
    ["duplicate declaration", [header, { type: "collection", name: "games" }, { type: "collection", name: "games" }]],
    ["data after completion", [header, user, { type: "complete", counts: {} }, { type: "user", row: null }]],
  ])("rejects %s", (_name, rows) => {
    const parser = new ExportNdjson({ format: "sc2tools-account-export", apiOwner: "owner-a" });
    expect(() => { parser.push(lines(...rows as unknown[])); parser.finish(); }).toThrow();
  });

  it("rejects an over-budget record before decoding or retaining it", () => {
    const parser = new ExportNdjson({ format: "sc2tools-account-export", apiOwner: "owner-a" });
    expect(() => parser.push(new Uint8Array(17 * 1024 * 1024 + 1).fill(32))).toThrowError(expect.objectContaining({ code: "too_large" }));
  });

  it("requires the distinct five-field build page and its exact terminal event count", () => {
    const parser = new ExportNdjson({ format: "sc2tools-build-order-export" });
    parser.push(lines({ type: "metadata", format: "sc2tools-build-order-export", version: 1,
      games: 1, fields: ["gameId", "side", "time", "supply", "name"] },
    { gameId: "game-a", side: "me", time: 63, supply: 17.5, name: "Marine" },
    { gameId: "game-a", side: "opponent", time: 63, supply: null, name: "Worker" },
    { type: "complete", games: 1, events: 2, continuation: "opaque-cursor" }));
    parser.finish();
    expect(parser.continuation).toBe("opaque-cursor");
    const invalid = new ExportNdjson({ format: "sc2tools-build-order-export" });
    expect(() => invalid.push(lines({ type: "metadata", format: "sc2tools-build-order-export", version: 1,
      games: 1, fields: ["gameId", "side", "time", "supply", "name"] },
    { type: "complete", games: 1, events: 1, continuation: null }))).toThrow();
  });
});

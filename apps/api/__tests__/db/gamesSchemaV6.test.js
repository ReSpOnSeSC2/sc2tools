// @ts-nocheck
"use strict";

const { COLLECTIONS } = require("../../src/config/constants");
const {
  VERSION_KEY,
  expectedVersion,
  migrateDoc,
  _internals,
} = require("../../src/db/schemaVersioning");
const {
  loadAllMigrations,
} = require("../../src/db/migrations");

describe("games schema v6 classifier fences", () => {
  beforeAll(() => {
    loadAllMigrations();
  });

  test("registers games v6 and forwards v5 rows without synthetic fields", () => {
    expect(expectedVersion(COLLECTIONS.GAMES)).toBe(6);
    const migrated = migrateDoc(
      {
        gameId: "legacy-game",
        map: "Rorschach LE",
        [VERSION_KEY]: 5,
      },
      COLLECTIONS.GAMES,
    );

    expect(migrated).toEqual({
      gameId: "legacy-game",
      map: "Rorschach LE",
      [VERSION_KEY]: 6,
    });
  });

  test("v6 rollback removes every server-private classifier fence", () => {
    const rolledBack = migrateDoc(
      {
        gameId: "fenced-game",
        myBuild: "PvT Macro",
        _customBuildRevision: "revision-1",
        _customBuildReclassify: [{ runId: "run-1", action: "set" }],
        _customBuildClassificationSequence: 42,
        _customBuildSlug: "pvt-macro",
        _opponentBuildOrderWriteLease: {
          id: "writer-1",
          leaseUntil: new Date("2026-08-13T22:00:00Z"),
        },
        [VERSION_KEY]: 6,
      },
      COLLECTIONS.GAMES,
      { targetVersion: 5 },
    );

    expect(rolledBack).toEqual({
      gameId: "fenced-game",
      myBuild: "PvT Macro",
      [VERSION_KEY]: 5,
    });
  });

  test("migration registration remains idempotent", () => {
    loadAllMigrations();
    loadAllMigrations();
    expect(_internals.MIGRATIONS.filter((migration) =>
      migration.collection === COLLECTIONS.GAMES
      && migration.fromVersion === 5
      && migration.toVersion === 6)).toHaveLength(1);
  });
});

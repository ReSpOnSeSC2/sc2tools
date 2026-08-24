// @ts-nocheck
"use strict";

const { COLLECTIONS } = require("../../src/config/constants");
const {
  VERSION_KEY,
  expectedVersion,
  migrateDoc,
  _internals,
} = require("../../src/db/schemaVersioning");
const { loadAllMigrations } = require("../../src/db/migrations");

describe("games schema v7 opponent custom-strategy provenance", () => {
  beforeAll(() => {
    loadAllMigrations();
  });

  test("registers games v7 and forwards v6 rows without synthetic fields", () => {
    expect(expectedVersion(COLLECTIONS.GAMES)).toBe(7);
    const migrated = migrateDoc(
      {
        gameId: "legacy-v6-game",
        myBuild: "PvT Macro",
        _customBuildSlug: "pvt-macro",
        [VERSION_KEY]: 6,
      },
      COLLECTIONS.GAMES,
    );

    expect(migrated).toEqual({
      gameId: "legacy-v6-game",
      myBuild: "PvT Macro",
      _customBuildSlug: "pvt-macro",
      [VERSION_KEY]: 7,
    });
  });

  test("v7 rollback removes only opponent custom-strategy provenance", () => {
    const rolledBack = migrateDoc(
      {
        gameId: "dual-axis-game",
        myBuild: "PvT Blink",
        opponent: { strategy: "TvP 3 Rax" },
        _customBuildRevision: "revision-1",
        _customBuildSlug: "pvt-blink",
        _customOpponentStrategySlug: "tvp-3-rax",
        [VERSION_KEY]: 7,
      },
      COLLECTIONS.GAMES,
      { targetVersion: 6 },
    );

    expect(rolledBack).toEqual({
      gameId: "dual-axis-game",
      myBuild: "PvT Blink",
      opponent: { strategy: "TvP 3 Rax" },
      _customBuildRevision: "revision-1",
      _customBuildSlug: "pvt-blink",
      [VERSION_KEY]: 6,
    });
  });

  test("migration registration remains idempotent", () => {
    loadAllMigrations();
    loadAllMigrations();
    expect(_internals.MIGRATIONS.filter((migration) =>
      migration.collection === COLLECTIONS.GAMES
      && migration.fromVersion === 6
      && migration.toVersion === 7)).toHaveLength(1);
  });
});

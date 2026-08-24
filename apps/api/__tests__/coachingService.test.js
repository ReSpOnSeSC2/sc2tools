// @ts-nocheck
"use strict";

const { COLLECTIONS } = require("../src/config/constants");
const { expectedVersion } = require("../src/db/schemaVersioning");
const { CoachingService } = require("../src/services/coaching");

describe("CoachingService", () => {
  test("putState stamps existing Locker documents with the current schema version", async () => {
    const updateOne = jest.fn().mockResolvedValue({
      matchedCount: 1,
      upsertedCount: 0,
    });
    const service = new CoachingService({
      db: { coaching: { updateOne } },
    });
    const state = { setup: true };

    await expect(service.putState(state, 3)).resolves.toEqual({
      ok: true,
      rev: 4,
    });

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "locker", rev: 3 },
      {
        $set: {
          state,
          rev: 4,
          updatedAt: expect.any(Date),
          _schemaVersion: expectedVersion(COLLECTIONS.COACHING),
        },
        $setOnInsert: { createdAt: expect.any(Date) },
      },
      { upsert: false },
    );
  });
});

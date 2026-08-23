// @ts-nocheck
"use strict";

const {
  DEFAULT_BROLL,
  MultichatStudioService,
  createBrollPlaybackOrder,
  prepareBrollUpdate,
  sanitizeBroll,
} = require("../src/services/multichatStudio");

const VIDEO_ID = "AbCdEf12345";

function clip(id, overrides = {}) {
  return {
    id,
    title: `Highlight ${id}`,
    videoId: VIDEO_ID,
    startSeconds: 10,
    endSeconds: 20,
    ...overrides,
  };
}

describe("multichat studio b-roll sanitizer", () => {
  test("legacy, null, and junk state receive independent safe defaults", () => {
    for (const value of [undefined, null, "junk", [], 42]) {
      const result = sanitizeBroll(value);
      expect(result).toEqual(DEFAULT_BROLL);
      expect(result).not.toBe(DEFAULT_BROLL);
      expect(result.clips).not.toBe(DEFAULT_BROLL.clips);
    }
  });
});

describe("multichat studio b-roll clip records", () => {
  test("whitelists clip fields and rejects unsafe or incoherent segments", () => {
    const result = sanitizeBroll({
      clips: [
        clip("valid_1", {
          title: `  ${"x".repeat(140)}  `,
          startSeconds: 1.9,
          endSeconds: 4.8,
          vertical: {
            videoId: "portrait123",
            startSeconds: 8.9,
            remoteUrl: "javascript:alert(1)",
          },
          remoteUrl: "javascript:alert(1)",
        }),
        clip("valid_1"), // duplicate client IDs are ambiguous — drop it.
        clip("bad/id"),
        clip("bad-video", { videoId: "https://youtu.be/AbCdEf12345" }),
        clip("empty-title", { title: "   " }),
        clip("string-time", { startSeconds: "10" }),
        clip("backwards", { startSeconds: 20, endSeconds: 10 }),
        clip("too-long", { startSeconds: 86_399, endSeconds: 86_401 }),
        clip("boundary", { startSeconds: 86_399, endSeconds: 86_400 }),
      ],
    });

    expect(result.clips).toEqual([
      {
        id: "valid_1",
        title: "x".repeat(120),
        videoId: VIDEO_ID,
        startSeconds: 1,
        endSeconds: 4,
        vertical: {
          videoId: "portrait123",
          startSeconds: 8,
        },
      },
      {
        id: "boundary",
        title: "Highlight boundary",
        videoId: VIDEO_ID,
        startSeconds: 86_399,
        endSeconds: 86_400,
      },
    ]);
    expect(result.clips[0].remoteUrl).toBeUndefined();
    expect(result.clips[0].vertical.remoteUrl).toBeUndefined();
  });

  test("drops malformed vertical sources without losing safe landscape clips", () => {
    const result = sanitizeBroll({
      clips: [
        clip("bad-pair", {
          vertical: { videoId: "not-video", startSeconds: 20 },
        }),
        clip("past-bound", {
          startSeconds: 10,
          endSeconds: 30,
          vertical: { videoId: "portrait123", startSeconds: 86_390 },
        }),
      ],
    });

    expect(result.clips).toEqual([
      clip("bad-pair"),
      clip("past-bound", { startSeconds: 10, endSeconds: 30 }),
    ]);
  });
});

describe("multichat studio b-roll bounds", () => {
  test("caps the playlist at 100 and clamps controls", () => {
    const clips = Array.from({ length: 105 }, (_, i) => clip(`clip-${i}`));
    const result = sanitizeBroll({
      clips,
      shuffle: false,
      muted: true,
      volume: 101.8,
      skipNonce: 9.9,
    });
    expect(result.clips).toHaveLength(100);
    expect(result.clips[99].id).toBe("clip-99");
    expect(result).toMatchObject({
      shuffle: false,
      muted: true,
      volume: 100,
      skipNonce: 9,
    });

    expect(
      sanitizeBroll({
        shuffle: "false",
        muted: 1,
        volume: "50",
        skipNonce: -10,
      }),
    ).toMatchObject({
      shuffle: true,
      muted: false,
      volume: 20,
      skipNonce: 0,
    });
  });
});

describe("authoritative synchronized b-roll timeline", () => {
  test("library changes mint one server-owned epoch/revision/seed", () => {
    const configured = prepareBrollUpdate(
      {
        clips: [clip("a"), clip("b")],
        shuffle: true,
        muted: false,
        volume: 20,
        skipNonce: 0,
        playback: {
          epochMs: 999_999,
          revision: 999,
          seed: 999,
          cursor: 1,
        },
      },
      DEFAULT_BROLL,
      10_000,
    );

    expect(configured.playback).toMatchObject({
      epochMs: 10_000,
      revision: 1,
      cursor: 0,
    });
    expect(configured.playback.seed).not.toBe(999);
    const firstOrder = createBrollPlaybackOrder(
      configured.clips.length,
      configured.shuffle,
      configured.playback.seed,
    );
    expect(firstOrder).toEqual(
      createBrollPlaybackOrder(
        configured.clips.length,
        configured.shuffle,
        configured.playback.seed,
      ),
    );
  });

  test("audio-only writes preserve the timeline and skip advances from now", () => {
    const configured = prepareBrollUpdate(
      {
        clips: [
          clip("a", {
            vertical: { videoId: "portrait123", startSeconds: 30 },
          }),
          clip("b"),
          clip("c"),
        ],
        shuffle: false,
        muted: false,
        volume: 20,
        skipNonce: 0,
      },
      DEFAULT_BROLL,
      10_000,
    );
    const audioUpdate = prepareBrollUpdate(
      { muted: true, volume: 5 },
      configured,
      15_000,
    );
    expect(audioUpdate.playback).toEqual(configured.playback);
    expect(audioUpdate.clips[0].vertical).toEqual({
      videoId: "portrait123",
      startSeconds: 30,
    });

    // At +15s the shared schedule is halfway through clip B. Skip must anchor
    // clip C, rather than incrementing the originally persisted A cursor.
    const skipped = prepareBrollUpdate(
      { skipNonce: 1 },
      audioUpdate,
      25_000,
    );
    expect(skipped.playback).toEqual({
      epochMs: 25_000,
      revision: configured.playback.revision + 1,
      seed: configured.playback.seed,
      cursor: 2,
    });
  });

  test("changing only a vertical pairing resets the shared timeline", () => {
    const configured = prepareBrollUpdate(
      {
        clips: [
          clip("paired", {
            vertical: { videoId: "portrait123", startSeconds: 50 },
          }),
        ],
      },
      DEFAULT_BROLL,
      10_000,
    );
    const changed = prepareBrollUpdate(
      {
        clips: [
          clip("paired", {
            vertical: { videoId: "portrait123", startSeconds: 51 },
          }),
        ],
      },
      configured,
      20_000,
    );

    expect(changed.playback.epochMs).toBe(20_000);
    expect(changed.playback.revision).toBe(configured.playback.revision + 1);
  });
});

describe("MultichatStudioService b-roll persistence", () => {
  test("never returns either legacy or canonical studio token fields", async () => {
    const canonical = {
      studioKey: "secret-token",
      broll: { volume: 11 },
    };
    const legacy = {
      token: "secret-token",
      broll: { volume: 99 },
    };
    const col = {
      findOne: jest.fn(async (filter, options) => {
        const found = Object.hasOwn(filter, "studioKey")
          ? canonical
          : legacy;
        const projected = { ...found };
        for (const [key, excluded] of Object.entries(
          options?.projection || {},
        )) {
          if (excluded === 0) delete projected[key];
        }
        return projected;
      }),
    };
    const service = new MultichatStudioService({ multichatStudio: col });

    const state = await service.get("secret-token");

    expect(state.broll.volume).toBe(11);
    expect(state).not.toHaveProperty("studioKey");
    expect(state).not.toHaveProperty("token");
    expect(col.findOne).toHaveBeenCalledWith(
      { studioKey: "secret-token" },
      { projection: { _id: 0, token: 0, studioKey: 0 } },
    );
  });

  test("persists the sanitized state and uses the existing socket event", async () => {
    let stored = null;
    const col = {
      findOne: jest.fn(async () => stored),
      updateOne: jest.fn(async (_filter, update) => {
        stored = {
          ...(stored || {}),
          ...(update.$setOnInsert || {}),
          ...(update.$set || {}),
        };
      }),
    };
    const emissions = [];
    const io = {
      to: (room) => ({
        emit: (event, payload) => emissions.push({ room, event, payload }),
      }),
    };
    const service = new MultichatStudioService(
      { multichatStudio: col },
      { io },
    );

    expect((await service.get("legacy-token")).broll).toEqual(DEFAULT_BROLL);
    const state = await service.update("legacy-token", {
      broll: {
        clips: [clip("persisted", { extra: true })],
        shuffle: false,
        muted: true,
        volume: 35,
        skipNonce: 2,
      },
    });

    expect(stored.broll).toEqual(state.broll);
    expect(stored.broll.clips[0].extra).toBeUndefined();
    expect(emissions).toEqual([
      {
        room: "overlay:legacy-token",
        event: "overlay:multichat",
        payload: state,
      },
    ]);
  });

  test("serializes partial controls so a concurrent audio save cannot undo Skip", async () => {
    let stored = null;
    const col = {
      findOne: jest.fn(async () => stored),
      updateOne: jest.fn(async (_filter, update) => {
        // Yield inside the write to make two immediately-issued requests
        // overlap unless the service's same-token queue is working.
        await new Promise((resolve) => setImmediate(resolve));
        stored = {
          ...(stored || {}),
          ...(update.$setOnInsert || {}),
          ...(update.$set || {}),
        };
      }),
    };
    const service = new MultichatStudioService({ multichatStudio: col });
    const configured = await service.update("race-token", {
      broll: {
        clips: [clip("a"), clip("b")],
        shuffle: false,
        muted: false,
        volume: 20,
        skipNonce: 0,
      },
    });

    const skipPromise = service.update("race-token", {
      broll: { skipNonce: 1 },
    });
    const audioPromise = service.update("race-token", {
      broll: { volume: 5 },
    });
    const [skipped, afterAudio] = await Promise.all([
      skipPromise,
      audioPromise,
    ]);

    expect(skipped.broll.skipNonce).toBe(1);
    expect(afterAudio.broll).toMatchObject({ skipNonce: 1, volume: 5 });
    expect(afterAudio.broll.playback).toEqual(skipped.broll.playback);
    expect(afterAudio.broll.playback.revision).toBe(
      configured.broll.playback.revision + 1,
    );
  });

  test("Mongo revision CAS preserves controls across two API service instances", async () => {
    let stored = null;
    const col = {
      findOne: jest.fn(async (filter) => {
        if (Object.hasOwn(filter, "studioKey")) {
          return stored?.studioKey === filter.studioKey ? stored : null;
        }
        return stored?.token === filter.token ? stored : null;
      }),
      updateOne: jest.fn(async (filter, update, options = {}) => {
        await new Promise((resolve) => setImmediate(resolve));
        const storedRevision = stored?.brollWriteRevision;
        const revisionMatches = Object.hasOwn(
          filter,
          "brollWriteRevision",
        )
          ? storedRevision === filter.brollWriteRevision
          : Array.isArray(filter.$or)
            ? storedRevision === 0 || storedRevision === undefined
            : true;
        const identityMatches = Object.hasOwn(filter, "studioKey")
          ? stored?.studioKey === filter.studioKey
          : Object.hasOwn(filter, "_id")
            ? stored?._id === filter._id
            : stored?.token === filter.token;
        const matches = identityMatches && revisionMatches;
        if (matches) {
          stored = {
            ...stored,
            ...(update.$set || {}),
          };
          return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
        }
        if (options.upsert) {
          if (stored) {
            const duplicate = new Error("duplicate token");
            duplicate.code = 11000;
            throw duplicate;
          }
          stored = {
            ...(update.$setOnInsert || {}),
            ...(update.$set || {}),
          };
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      }),
    };
    const serviceA = new MultichatStudioService({ multichatStudio: col });
    const serviceB = new MultichatStudioService({ multichatStudio: col });
    const configured = await serviceA.update("shared-token", {
      broll: {
        clips: [clip("a"), clip("b")],
        shuffle: false,
        muted: false,
        volume: 20,
        skipNonce: 0,
      },
    });

    await Promise.all([
      serviceA.update("shared-token", { broll: { skipNonce: 1 } }),
      serviceB.update("shared-token", { broll: { volume: 7 } }),
    ]);
    const final = await serviceA.get("shared-token");
    expect(final.broll).toMatchObject({ skipNonce: 1, volume: 7 });
    expect(final.broll.playback.revision).toBe(
      configured.broll.playback.revision + 1,
    );

    await Promise.all([
      serviceA.update("shared-token", { broll: { volume: 9 } }),
      serviceB.update("shared-token", { broll: { muted: true } }),
    ]);
    const afterAudioRace = await serviceA.get("shared-token");
    expect(afterAudioRace.broll).toMatchObject({ volume: 9, muted: true });
    expect(afterAudioRace.broll.playback).toEqual(final.broll.playback);
  });

  test("Mongo revision CAS also merges two simultaneous first writes", async () => {
    let stored = null;
    const col = {
      findOne: jest.fn(async (filter) => {
        if (Object.hasOwn(filter, "studioKey")) {
          return stored?.studioKey === filter.studioKey ? stored : null;
        }
        return stored?.token === filter.token ? stored : null;
      }),
      updateOne: jest.fn(async (filter, update, options = {}) => {
        await new Promise((resolve) => setImmediate(resolve));
        const storedRevision = stored?.brollWriteRevision;
        const expectedRevision = filter.brollWriteRevision;
        const revisionMatches = expectedRevision?.$exists === false
          ? storedRevision === undefined
          : expectedRevision === undefined
            ? true
            : storedRevision === expectedRevision;
        const identityMatches = Object.hasOwn(filter, "studioKey")
          ? stored?.studioKey === filter.studioKey
          : Object.hasOwn(filter, "_id")
            ? stored?._id === filter._id
            : stored?.token === filter.token;
        const matches = identityMatches && revisionMatches;
        if (matches) {
          stored = { ...stored, ...(update.$set || {}) };
          return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
        }
        if (options.upsert) {
          if (stored) {
            const duplicate = new Error("duplicate token");
            duplicate.code = 11000;
            throw duplicate;
          }
          stored = {
            ...(update.$setOnInsert || {}),
            ...(update.$set || {}),
          };
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      }),
    };
    const serviceA = new MultichatStudioService({ multichatStudio: col });
    const serviceB = new MultichatStudioService({ multichatStudio: col });

    await Promise.all([
      serviceA.update("new-shared-token", {
        broll: { clips: [clip("a"), clip("b")] },
      }),
      serviceB.update("new-shared-token", { broll: { volume: 7 } }),
    ]);

    const final = await serviceA.get("new-shared-token");
    expect(final.broll.clips.map((item) => item.id)).toEqual(["a", "b"]);
    expect(final.broll.volume).toBe(7);
    const insertFilters = col.updateOne.mock.calls
      .filter(([, , options]) => options?.upsert)
      .map(([filter]) => filter);
    expect(insertFilters).toContainEqual({
      studioKey: "new-shared-token",
      brollWriteRevision: { $exists: false },
    });
  });

  test("a legacy duplicate token lazily promotes one canonical row", async () => {
    const docs = [
      {
        _id: "legacy-a",
        token: "duplicate-token",
        broll: { volume: 11, muted: false },
      },
      {
        _id: "legacy-b",
        token: "duplicate-token",
        broll: { volume: 99, muted: false },
      },
    ];
    const col = {
      findOne: jest.fn(async (filter) => {
        if (Object.hasOwn(filter, "studioKey")) {
          return docs.find((doc) => doc.studioKey === filter.studioKey) || null;
        }
        return docs.find((doc) => doc.token === filter.token) || null;
      }),
      updateOne: jest.fn(async (filter, update) => {
        const doc = Object.hasOwn(filter, "_id")
          ? docs.find((item) => item._id === filter._id)
          : docs.find((item) => item.studioKey === filter.studioKey);
        if (!doc) {
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        }
        Object.assign(doc, update.$set || {});
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }),
    };
    const service = new MultichatStudioService({ multichatStudio: col });

    const state = await service.update("duplicate-token", {
      broll: { muted: true },
    });

    expect(state.broll).toMatchObject({ volume: 11, muted: true });
    expect(docs[0].studioKey).toBe("duplicate-token");
    expect(docs[1].studioKey).toBeUndefined();
    expect((await service.get("duplicate-token")).broll.volume).toBe(11);
  });
});

// @ts-nocheck
"use strict";

const {
  DEFAULT_BROLL,
  MultichatStudioService,
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

describe("MultichatStudioService b-roll persistence", () => {
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
});

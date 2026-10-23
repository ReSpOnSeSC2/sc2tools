import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { sanitizeStudioState } from "../useStudioState";
import { testScene } from "../testStudio";
import { STUDIO_SCENE_HEADLINES, type StudioSceneMode } from "../sceneModes";
const require = createRequire(import.meta.url);
const { sanitizeScene } = require("../../../../api/src/services/multichatStudio.js");

describe("API/client scene mode compatibility", () => {
  it.each(Object.keys(STUDIO_SCENE_HEADLINES) as StudioSceneMode[])("accepts %s across API, client and fixture", (mode) => {
    const input = { mode, message: "A break", countdownEndsAt: Date.now() + 60_000 };
    const server = sanitizeScene(input);
    const client = sanitizeStudioState({ scene: input }).scene;
    expect(server).toMatchObject(input);
    expect(client).toMatchObject(input);
    expect(testScene(123, mode).mode).toBe(mode);
  });
  it.each(["party", "__proto__", "constructor", "toString", "", null, 1])("treats unknown %s as transparent live", (mode) => {
    expect(sanitizeScene({ mode })).toBeNull();
    expect(sanitizeStudioState({ scene: { mode } }).scene).toBeNull();
  });
});

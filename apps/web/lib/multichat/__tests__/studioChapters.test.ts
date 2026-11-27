import { describe, expect, it } from "vitest";
import { DEFAULT_STUDIO_STATE, sanitizeStudioState } from "../useStudioState";

describe("studio game chapters", () => {
  it("keeps the YouTube switch off unless it is exactly true", () => {
    expect(DEFAULT_STUDIO_STATE.youtubeChapters).toBe(false);
    expect(sanitizeStudioState({ youtubeChapters: "true" }).youtubeChapters).toBe(false);
    expect(sanitizeStudioState({ youtubeChapters: true }).youtubeChapters).toBe(true);
  });

  it("reads the End stream answer and drops anything malformed", () => {
    const chapters = { state: "written", message: "Added the game chapters to the YouTube archive." };
    expect(sanitizeStudioState({ deskAction: { streamReport: null, chapters } }).streamChapters).toEqual(chapters);
    expect(sanitizeStudioState({ deskAction: { streamReport: null, chapters: null } }).streamChapters).toBeNull();
    expect(sanitizeStudioState({ deskAction: { chapters: { state: "done", message: "x" } } }).streamChapters).toBeNull();
    expect(sanitizeStudioState({ deskAction: { chapters: { state: "failed", message: "y".repeat(500) } } }).streamChapters?.message).toHaveLength(300);
    expect("streamChapters" in sanitizeStudioState({ highlight: null })).toBe(false);
  });
});

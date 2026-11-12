import { describe, expect, it } from "vitest";
import { practiceLinkPath, practiceLinks, readPracticeLinks } from "./practiceLinks";

const link = { alias: "test-opening", communitySlug: `build-${"a".repeat(32)}`, youtubeId: "1234567890_", creator: "Fixture creator", offsetSec: 14, patchEra: "before", gradeEndSec: 300 };

describe("owner Practice Link registry", () => {
  it("validates the committed registry and constructs a bounded alias path", () => {
    expect(readPracticeLinks(practiceLinks)).toEqual(practiceLinks);
    expect(practiceLinkPath(readPracticeLinks([link])[0])).toBe("/b/test-opening");
  });

  it.each([
    { alias: "weekly" }, { alias: "Bad/alias" }, { communitySlug: "private-slug" },
    { youtubeId: "https://example.com/" }, { creator: " " }, { offsetSec: -1 },
    { patchEra: "guess" }, { gradeEndSec: 0 },
  ])("rejects an invalid field %#", (invalid) => {
    expect(() => readPracticeLinks([{ ...link, ...invalid }])).toThrow("Invalid Practice Link entry");
  });

  it("rejects aliases or publications that occur twice", () => {
    expect(() => readPracticeLinks([link, { ...link, alias: "other" }])).toThrow("Duplicate");
    expect(() => readPracticeLinks([link, { ...link, communitySlug: `build-${"b".repeat(32)}` }])).toThrow("Duplicate");
  });
});

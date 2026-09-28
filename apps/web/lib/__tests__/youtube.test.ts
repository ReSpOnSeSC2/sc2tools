import { describe, expect, it } from "vitest";
import { parseYouTubeVideoId } from "@/lib/youtube";
import { parseYouTubeVideoId as brollReExport } from "@/components/dock/BrollLibraryEditor";

const ID = "YcTMc_Ee11w";

describe("parseYouTubeVideoId", () => {
  it.each([
    [ID, ID],
    [`  ${ID}  `, ID],
    [`https://www.youtube.com/watch?v=${ID}&t=90`, ID],
    [`youtube.com/watch?v=${ID}`, ID],
    [`https://m.youtube.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}?si=share`, ID],
    [`https://www.youtube.com/shorts/${ID}`, ID],
    [`https://youtube.com/live/${ID}`, ID],
    [`https://www.youtube-nocookie.com/embed/${ID}`, ID],
  ])("accepts %j", (input, expected) => {
    expect(parseYouTubeVideoId(input)).toBe(expected);
  });

  it.each([
    `https://example.com/watch?v=${ID}`,
    `https://youtube.com.evil.test/watch?v=${ID}`,
    "https://www.youtube.com/@ReSpOnSeSC2",
    "too-short",
    "",
    "javascript:alert(1)",
  ])("rejects %j", (input) => {
    expect(parseYouTubeVideoId(input)).toBeNull();
  });

  it("stays re-exported from the B-roll editor for existing imports", () => {
    expect(brollReExport).toBe(parseYouTubeVideoId);
  });
});

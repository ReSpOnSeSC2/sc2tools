import { describe, expect, it } from "vitest";
import { canonicalTag, effectiveVisibility, formatGameClock, normalizeTagList, undoInput, type NoteDto } from "../notes";
import { replayNotes, replayReview, replayTag } from "../replayListNavigation";
import { gameSourceFilters } from "../gameSourceFilters";

describe("notes rules", () => {
  it("canonicalises preset tags and drops duplicates, blanks and long tags", () => {
    expect(canonicalTag("  #cheeser ")).toBe("Cheeser");
    expect(canonicalTag("   ")).toBeNull();
    expect(normalizeTagList(["proxy", "Proxy", "", "x".repeat(25), "Late game"])).toEqual(["Proxy", "Late game"]);
    expect(normalizeTagList(["a", "b", "c", "d", "e", "f"], 5)).toHaveLength(5);
  });

  it("a private tag wins over Show on stream", () => {
    expect(effectiveVisibility("stream", ["Macro"])).toBe("stream");
    expect(effectiveVisibility("stream", ["toxic"])).toBe("private");
  });

  it("formats game clocks and rebuilds a deleted note for Undo", () => {
    expect(formatGameClock(252)).toBe("4:12");
    expect(formatGameClock(3725)).toBe("1:02:05");
    expect(formatGameClock(-3)).toBe("0:00");
    const note = { text: "t", tags: ["Macro"], pinned: true, gameTimeSec: 10, x: 1, y: 2 } as NoteDto;
    expect(undoInput(note)).toEqual({ text: "t", tags: ["Macro"], pinned: true, gameTimeSec: 10, x: 1, y: 2 });
    expect(undoInput({ ...note, x: null, y: null, gameTimeSec: null })).toEqual({ text: "t", tags: ["Macro"], pinned: true, gameTimeSec: null });
  });

  it("review queue URL state is allowlisted and carried to game navigation", () => {
    expect(replayReview("todo")).toBe("todo");
    expect(replayReview("later")).toBe("all");
    expect(replayNotes("has")).toBe("has");
    expect(replayNotes("1")).toBe("all");
    expect(replayTag(" Macro ")).toBe("Macro");
    expect(replayTag("x".repeat(25))).toBe("");
    expect(new URLSearchParams(gameSourceFilters("review=todo&review_tag=Macro&notes=has&cursor=abc")).toString()).toBe("review=todo&review_tag=Macro&notes=has");
  });
});

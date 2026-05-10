import { describe, expect, test } from "vitest";
import { isBarcodeName, pickPulseLabel } from "../sc2pulse";

describe("isBarcodeName", () => {
  test("classic ASCII barcodes are detected", () => {
    expect(isBarcodeName("IIlIlI")).toBe(true);
    expect(isBarcodeName("lIlIlIlIlI")).toBe(true);
    expect(isBarcodeName("||||")).toBe(true);
    expect(isBarcodeName("11111")).toBe(true);
    expect(isBarcodeName("iiiIIIlll")).toBe(true);
  });

  test("real names are not flagged", () => {
    expect(isBarcodeName("Maru")).toBe(false);
    expect(isBarcodeName("Serral")).toBe(false);
    expect(isBarcodeName("Player1")).toBe(false);
    expect(isBarcodeName("i love sc2")).toBe(false); // contains a space
    expect(isBarcodeName("Reaper")).toBe(false);
  });

  test("empty / whitespace-only inputs are not flagged", () => {
    expect(isBarcodeName("")).toBe(false);
    expect(isBarcodeName("   ")).toBe(false);
    expect(isBarcodeName(null)).toBe(false);
    expect(isBarcodeName(undefined)).toBe(false);
  });

  test("unicode lookalikes (Greek iota, fullwidth glyphs, Roman numeral) are caught", () => {
    expect(isBarcodeName("ΙΙΙΙ")).toBe(true); // Greek capital iota
    expect(isBarcodeName("ⅠⅠⅠⅠ")).toBe(true); // Roman numeral one
    expect(isBarcodeName("ＩｌＩｌ")).toBe(true); // fullwidth I/l
    expect(isBarcodeName("|｜|｜")).toBe(true); // mix ASCII + fullwidth pipe
    expect(isBarcodeName("１１１１")).toBe(true); // fullwidth digit one
  });

  test("a single non-barcode character defeats the match", () => {
    expect(isBarcodeName("IIIIIa")).toBe(false);
    expect(isBarcodeName("Maru1")).toBe(false);
  });

  test("trims leading/trailing whitespace before classifying", () => {
    expect(isBarcodeName("  IIII  ")).toBe(true);
    expect(isBarcodeName("\tllll\n")).toBe(true);
  });
});

describe("pickPulseLabel", () => {
  test("prefers pulseCharacterId when present", () => {
    expect(pickPulseLabel({ pulseCharacterId: "994428" })).toEqual({
      value: "994428",
      isPulseCharacterId: true,
    });
  });
  test("falls back to toonHandle then pulseId", () => {
    expect(pickPulseLabel({ toonHandle: "1-S2-1-267727" })).toEqual({
      value: "1-S2-1-267727",
      isPulseCharacterId: false,
    });
    expect(pickPulseLabel({ pulseId: "abc" })).toEqual({
      value: "abc",
      isPulseCharacterId: false,
    });
  });
  test("returns null when nothing is identifiable", () => {
    expect(pickPulseLabel({})).toBeNull();
    expect(pickPulseLabel({ pulseCharacterId: "", toonHandle: "  " })).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Coaching Locker's replay picker keeps each game's own patch under the
// patch filters: 5.0.16 games are still played after the 5.0.17 notes.
const template = readFileSync(
  resolve(process.cwd(), "../../coaching/locker_app_template.html"),
  "utf8",
);
const generated = readFileSync(
  resolve(process.cwd(), "public/coaching/locker-site.html"),
  "utf8",
);

function block(source: string): string {
  const start = source.indexOf("function presetRange(");
  const end = source.indexOf("let S;", start);
  return source.slice(start, end);
}

type Row = { d: string; e?: string };
type Picker = {
  presetRange: (p: string) => [string | null, string | null];
  presetEra: (p: string) => string;
  gameEra: (g: Row) => string;
};

const picker = new Function(
  "isoD",
  "seasonRangeJS",
  "PK",
  `${block(template)}; return { presetRange, presetEra, gameEra };`,
)(
  (d: Date) => d.toISOString().slice(0, 10),
  () => [null, null],
  {},
) as Picker;

describe("Coaching Locker patch filters", () => {
  it("matches the generated site page", () => {
    expect(block(generated)).toBe(block(template));
  });

  it("bounds the patch presets by day and leaves the split to each game's patch", () => {
    expect(picker.presetRange("after_5_0_17")).toEqual(["2026-09-30", null]);
    expect(picker.presetRange("patch_5_0_16")).toEqual(["2026-06-22", null]);
    expect(picker.presetEra("after_5_0_17")).toBe("after");
    expect(picker.presetEra("patch_5_0_16")).toBe("before");
    expect(picker.presetEra("before_5_0_16")).toBe("");
    expect(picker.presetEra("last_7d")).toBe("");
  });

  it("uses the era the site sends, else the game's day", () => {
    // A 5.0.16 game played the day the 5.0.17 notes came out.
    expect(picker.gameEra({ d: "2026-09-30", e: "before" })).toBe("before");
    expect(picker.gameEra({ d: "2026-10-08", e: "after" })).toBe("after");
    // A 5.0.17 PTR game from the site.
    expect(picker.gameEra({ d: "2026-09-30", e: "after" })).toBe("after");
    // No era: 8 workers from 5.0.16 until 5.0.17 reaches the live ladder.
    expect(picker.gameEra({ d: "2026-08-01" })).toBe("before");
    expect(picker.gameEra({ d: "2026-09-30" })).toBe("before");
    expect(picker.gameEra({ d: "2026-06-01" })).toBe("after");
  });
});

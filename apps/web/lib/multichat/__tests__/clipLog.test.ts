import { expect, it } from "vitest";
import { clipMomentsCsv, clipTimestampText } from "../clipLog";
import { toYouTubeChapters } from "@/lib/vodLinks";
import type { ClipMoment } from "../useEngagementState";

const start = Date.parse("2026-11-10T20:00:00Z");
const moment = (offset: number, reason: string, sampleLines: string[] = []): ClipMoment => ({
  atMs: start + offset, kind: "manual", reason, sampleLines,
});

it("keeps stream start and chapter gaps, cleans titles, and drops moments before the stream", () => {
  const rows = [
    moment(20_000, "Too near"), moment(-2000, "Before"), moment(10_900, "Battle\nthen retreat"),
    moment(21_000, "X".repeat(120)), moment(3600_000, "Final"),
  ];
  expect(toYouTubeChapters(rows, start)).toEqual(["0:00 Stream start", "0:10 Battle then retreat", `0:21 ${"X".repeat(100)}`, "1:00:00 Final"]);
  expect(toYouTubeChapters(rows, null)).toEqual([]);
  expect(toYouTubeChapters([moment(9999, "Near"), moment(10_000, "Allowed")], start)).toHaveLength(2);
});

it("uses offsets consistently for marked streams and wall HH:MM otherwise", () => {
  const rows = [moment(15_000, "After"), moment(-2000, "Before")];
  expect(clipTimestampText(rows, start)).toBe("0:15 — After");
  const lines = clipTimestampText(rows, null).split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\d{2}:\d{2} — Before$/);
  expect(lines[1]).toMatch(/^\d{2}:\d{2} — After$/);
});

it("quotes CSV cells and neutralizes viewer formulas", () => {
  const csv = clipMomentsCsv([moment(25_000, '=HYPERLINK("x","y")', ["@mention", "line two"])], start);
  expect(csv.split("\r\n")[0]).toBe("offset,wall_time_iso,kind,reason,sample_lines");
  expect(csv).toContain(`0:25,2026-11-10T20:00:25.000Z,manual,"'=HYPERLINK(""x"",""y"")",'@mention | line two`);
});

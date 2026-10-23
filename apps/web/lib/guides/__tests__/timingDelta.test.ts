import { expect, it } from "vitest";
import { timingDelta } from "../timingDelta";

it.each([80, 120])("includes middle-half boundary %s as on pace", (value) => { expect(timingDelta(value, { median: 100, p25: 80, p75: 120 }).tone).toBe("on-pace"); });
it("explains early, late and sub-second differences", () => {
  expect(timingDelta(72, { median: 100, p25: 80, p75: 120 })).toMatchObject({ deltaSec: -28, label: "−28s", tone: "early" });
  expect(timingDelta(132, { median: 100, p25: 80, p75: 120 })).toMatchObject({ deltaSec: 32, label: "+32s", tone: "late", text: "Your median is 32 seconds later than the community median, later than most players" });
  expect(timingDelta(100.8, { median: 100, p25: 80, p75: 120 })).toMatchObject({ deltaSec: 0, label: "same", tone: "on-pace" });
});
it("keeps a median-only delta neutral when either boundary is missing", () => {
  for (const band of [{ median: 100 }, { median: 100, p25: 80 }, { median: 100, p75: 120 }]) expect(timingDelta(92, band)).toMatchObject({ label: "−8s", tone: null });
  expect(timingDelta(NaN, { median: 100 }).label).toBe("—");
});

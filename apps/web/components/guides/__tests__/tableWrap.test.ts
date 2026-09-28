import { describe, expect, it } from "vitest";
import { GUIDE_TABLE_WRAP_CLASS } from "@/components/guides/guideUi";

describe("GUIDE_TABLE_WRAP_CLASS", () => {
  it("scrolls wide tables and contains their absolutely positioned sr-only text", () => {
    // Without `relative`, a cell's sr-only span (position: absolute) escapes
    // the scroller and widens the page on phones.
    const classes = GUIDE_TABLE_WRAP_CLASS.split(/\s+/);
    expect(classes).toContain("overflow-x-auto");
    expect(classes).toContain("relative");
  });
});

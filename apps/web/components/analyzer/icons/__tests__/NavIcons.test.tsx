import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  ArcadeIcon,
  BuildsIcon,
  MapsIcon,
  OpponentsIcon,
  StrategiesIcon,
  TrendsIcon,
} from "../NavIcons";

/**
 * Smoke tests for the analyzer-dashboard nav icons. We don't
 * pixel-test the SVG paths — those are reviewed by eye in the PR —
 * but we DO want to lock in:
 *
 *   1. Every icon renders a single <svg> root (so consumers can
 *      style it as a lucide drop-in).
 *   2. Every icon honors the consumer's className (the sidebar
 *      passes Tailwind size + colour utilities through).
 *   3. Stroke uses currentColor (so parent text colour drives the
 *      icon colour — Tailwind text-accent-cyan etc.).
 *   4. fill=none on the svg root (filled accents inside each icon
 *      explicitly set fill=currentColor, but the root must stay
 *      transparent or we'd get a black block at small sizes).
 *
 * Regression target: if anyone re-exports these via a wrapper that
 * drops the className prop, the sidebar's active-tab cyan accent
 * silently disappears on desktop while still passing typecheck.
 */
describe("NavIcons", () => {
  afterEach(() => cleanup());

  const ICONS = [
    ["OpponentsIcon", OpponentsIcon],
    ["StrategiesIcon", StrategiesIcon],
    ["TrendsIcon", TrendsIcon],
    ["MapsIcon", MapsIcon],
    ["BuildsIcon", BuildsIcon],
    ["ArcadeIcon", ArcadeIcon],
  ] as const;

  for (const [name, Icon] of ICONS) {
    it(`${name} renders an svg with the consumer's className and currentColor stroke`, () => {
      const { container } = render(
        <Icon className="h-4 w-4 text-accent-cyan" aria-label="x" />,
      );
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute("class")).toContain("h-4");
      expect(svg!.getAttribute("class")).toContain("w-4");
      expect(svg!.getAttribute("stroke")).toBe("currentColor");
      expect(svg!.getAttribute("fill")).toBe("none");
      expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
      // Every icon must contribute at least 1 path / circle so it's
      // not an empty box at 16-20px sizes.
      const shapes = svg!.querySelectorAll("path, circle");
      expect(shapes.length).toBeGreaterThan(0);
    });
  }

  it("each icon is visually distinct (different total shape count)", () => {
    // Catches a copy-paste mistake where two icons end up sharing
    // the same path set. Not airtight — but cheap, and would have
    // caught the case where someone duplicated the Maps body into
    // Strategies during the initial design pass.
    const shapeCounts = ICONS.map(([, Icon]) => {
      const { container } = render(<Icon />);
      const count = container.querySelectorAll("path, circle").length;
      cleanup();
      return count;
    });
    // We don't require every count to be unique (Builds + Strategies
    // both happen to land at 4 shapes), but at least 4 of the 6 must
    // have distinct shape counts.
    const uniqueCounts = new Set(shapeCounts).size;
    expect(uniqueCounts).toBeGreaterThanOrEqual(4);
  });
});

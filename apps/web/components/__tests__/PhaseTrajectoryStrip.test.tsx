import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  PhaseTrajectoryStrip,
  type PhaseTrajectoryStripProps,
} from "@/components/analyzer/PhaseTrajectoryStrip";

afterEach(cleanup);

function baseProps(
  overrides: Partial<PhaseTrajectoryStripProps> = {},
): PhaseTrajectoryStripProps {
  return {
    sampleSize: { early: 12, earlyMid: 12, mid: 11, midLate: 8, late: 3 },
    crossings: {
      earlyMidAt: 120, // 20% of 600
      midAt: 240, // 40%
      midLateAt: 360, // 60%
      lateAt: 480, // 80%
    },
    finalPhaseDistribution: {
      early: 0,
      earlyMid: 0,
      mid: 4,
      midLate: 8,
      late: 2,
    },
    durationP95Sec: 600,
    ...overrides,
  };
}

describe("PhaseTrajectoryStrip", () => {
  it("renders all five phase bands", () => {
    const { container } = render(<PhaseTrajectoryStrip {...baseProps()} />);
    const bands = container.querySelectorAll('[data-testid="phase-band"]');
    expect(bands.length).toBe(5);
    const phases = Array.from(bands).map((b) => b.getAttribute("data-phase"));
    expect(phases).toEqual(["early", "earlyMid", "mid", "midLate", "late"]);
  });

  it("places crossing markers at the correct percentage positions", () => {
    const { container } = render(<PhaseTrajectoryStrip {...baseProps()} />);
    const markers = Array.from(
      container.querySelectorAll('[data-testid="phase-crossing"]'),
    );
    const byKey: Record<string, number> = {};
    for (const el of markers) {
      const key = el.getAttribute("data-key");
      const at = Number(el.getAttribute("data-at-pct"));
      if (key) byKey[key] = at;
    }
    expect(byKey.earlyMidAt).toBeCloseTo(20, 4);
    expect(byKey.midAt).toBeCloseTo(40, 4);
    expect(byKey.midLateAt).toBeCloseTo(60, 4);
    expect(byKey.lateAt).toBeCloseTo(80, 4);
  });

  it("skips crossing markers that are null", () => {
    const { container } = render(
      <PhaseTrajectoryStrip
        {...baseProps({
          crossings: {
            earlyMidAt: 60,
            midAt: 300,
            midLateAt: null,
            lateAt: null,
          },
        })}
      />,
    );
    const keys = Array.from(
      container.querySelectorAll('[data-testid="phase-crossing"]'),
    ).map((el) => el.getAttribute("data-key"));
    expect(keys.sort()).toEqual(["earlyMidAt", "midAt"]);
  });

  it("scales final-phase histogram heights proportionally to counts", () => {
    const { container } = render(
      <PhaseTrajectoryStrip
        {...baseProps({
          finalPhaseDistribution: {
            early: 0,
            earlyMid: 0,
            mid: 4,
            midLate: 8,
            late: 2,
          },
        })}
      />,
    );
    const byPhase: Record<string, number> = {};
    container
      .querySelectorAll('[data-testid="phase-final-bar"]')
      .forEach((el) => {
        const phase = el.getAttribute("data-phase") ?? "";
        const h = Number(el.getAttribute("data-height-pct"));
        byPhase[phase] = h;
      });
    // Max count = 8 → midLate is the 100% reference.
    expect(byPhase.midLate).toBeCloseTo(100, 4);
    expect(byPhase.mid).toBeCloseTo(50, 4);
    expect(byPhase.late).toBeCloseTo(25, 4);
    expect(byPhase.early).toBeCloseTo(0, 4);
    expect(byPhase.earlyMid).toBeCloseTo(0, 4);
  });

  it("renders only the 'where games end' stacked bar in outcomeOnly mode", () => {
    const { container } = render(
      <PhaseTrajectoryStrip {...baseProps({ outcomeOnly: true })} />,
    );
    // Stacked bar is present with one segment per phase.
    expect(
      container.querySelector('[data-testid="phase-histogram"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[data-testid="phase-final-bar"]').length,
    ).toBe(5);
    // Median-timing bands and crossing markers are suppressed — the
    // outcomeOnly variant is the bar-only renderer the comparison
    // columns rely on.
    expect(
      container.querySelector('[data-testid="phase-bands"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="phase-crossing"]').length,
    ).toBe(0);
    expect(
      container.querySelector('[data-testid="phase-labels"]'),
    ).toBeNull();
  });

  it("hides labels and histogram in compact mode but keeps bands and crossings", () => {
    const { container } = render(
      <PhaseTrajectoryStrip {...baseProps({ compact: true })} />,
    );
    expect(
      container.querySelector('[data-testid="phase-labels"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="phase-histogram"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="phase-band"]').length,
    ).toBe(5);
    expect(
      container.querySelectorAll('[data-testid="phase-crossing"]').length,
    ).toBe(4);
    const bandsHost = container.querySelector('[data-testid="phase-bands"]');
    expect(bandsHost?.getAttribute("data-compact")).toBe("1");
  });

  it("includes percentages for each final phase in the screen-reader caption", () => {
    const { container } = render(
      <PhaseTrajectoryStrip
        {...baseProps({
          finalPhaseDistribution: {
            early: 0,
            earlyMid: 0,
            mid: 4,
            midLate: 8,
            late: 2,
          },
        })}
      />,
    );
    const caption = container.querySelector("figcaption");
    expect(caption).not.toBeNull();
    const text = caption!.textContent ?? "";
    // 14 games total: mid=4 (29%), midLate=8 (57%), late=2 (14%).
    expect(text).toMatch(/Mid 29%/);
    expect(text).toMatch(/Mid\/Late 57%/);
    expect(text).toMatch(/Late 14%/);
    expect(text).toMatch(/Early 0%/);
  });

  it("renders the empty state when every sample bucket is zero", () => {
    const { container } = render(
      <PhaseTrajectoryStrip
        {...baseProps({
          sampleSize: {
            early: 0,
            earlyMid: 0,
            mid: 0,
            midLate: 0,
            late: 0,
          },
        })}
      />,
    );
    expect(
      container.querySelector('[data-testid="phase-trajectory-strip"]'),
    ).toBeNull();
    expect(container.textContent).toMatch(/Not enough games on this build yet/i);
  });

  describe("theme parity", () => {
    it("renders identically structured DOM in both themes", () => {
      document.documentElement.setAttribute("data-theme", "light");
      const { container: light } = render(
        <PhaseTrajectoryStrip {...baseProps()} />,
      );
      const lightSnapshot = stripStyles(light.innerHTML);
      cleanup();

      document.documentElement.setAttribute("data-theme", "dark");
      const { container: dark } = render(
        <PhaseTrajectoryStrip {...baseProps()} />,
      );
      const darkSnapshot = stripStyles(dark.innerHTML);

      expect(lightSnapshot).toEqual(darkSnapshot);
    });
  });

  describe("responsive", () => {
    const breakpoints = { mobile: 375, tablet: 768, desktop: 1280 } as const;
    Object.entries(breakpoints).forEach(([name, width]) => {
      it(`renders at ${name} (${width}px) without horizontal overflow`, () => {
        Object.defineProperty(window, "innerWidth", {
          writable: true,
          configurable: true,
          value: width,
        });
        window.dispatchEvent(new Event("resize"));
        const { container } = render(
          <PhaseTrajectoryStrip {...baseProps()} />,
        );
        const overflowing = Array.from(
          container.querySelectorAll<HTMLElement>("*"),
        ).filter((el) => el.scrollWidth > el.clientWidth + 1);
        expect(overflowing).toEqual([]);
      });
    });
  });
});

function stripStyles(html: string): string {
  return html
    .replace(/\sstyle="[^"]*"/g, "")
    .replace(/\sdata-theme="[^"]*"/g, "");
}

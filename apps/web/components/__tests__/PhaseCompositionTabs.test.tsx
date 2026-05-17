import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  PhaseCompositionTabs,
  type PhaseCompositionTabsProps,
  type Phase,
  type PhaseCompositionRow,
} from "@/components/analyzer/PhaseCompositionTabs";

afterEach(cleanup);

function emptyRow(): PhaseCompositionRow {
  return { signatures: [], tech: [], upgrades: [] };
}

function baseProps(
  overrides: Partial<PhaseCompositionTabsProps> = {},
): PhaseCompositionTabsProps {
  const perPhase: Record<Phase, PhaseCompositionRow> = {
    early: {
      signatures: [
        {
          key: "Zergling",
          units: [{ token: "Zergling", count: 12 }],
          sampleCount: 9,
          wins: 6,
          losses: 3,
          winRate: 6 / 9,
          sampleGameIds: ["g1", "g2", "g3"],
        },
        {
          key: "Drone",
          units: [{ token: "Zergling", count: 6 }],
          sampleCount: 3,
          wins: 1,
          losses: 2,
          winRate: 1 / 3,
          sampleGameIds: ["g4", "g5"],
        },
      ],
      tech: [
        // Pre-sorted; positions tested by data attrs.
        { token: "SpawningPool", sampleCount: 9, medianFirstSeen: 80, p25: 70, p75: 100 },
        { token: "RoachWarren", sampleCount: 4, medianFirstSeen: 160, p25: 140, p75: 180 },
      ],
      upgrades: [],
    },
    earlyMid: {
      signatures: [
        {
          key: "Zergling|Roach",
          units: [
            { token: "Zergling", count: 18 },
            { token: "Roach", count: 8 },
          ],
          sampleCount: 7,
          wins: 5,
          losses: 2,
          winRate: 5 / 7,
          sampleGameIds: ["em1", "em2", "em3"],
        },
      ],
      tech: [],
      upgrades: [],
    },
    mid: emptyRow(),
    midLate: emptyRow(),
    late: emptyRow(),
  };
  return {
    sampleSize: { early: 12, earlyMid: 7, mid: 3, midLate: 0, late: 0 },
    perPhase,
    ...overrides,
  };
}

describe("PhaseCompositionTabs", () => {
  it("renders five tab buttons with the right counts", () => {
    const { container } = render(<PhaseCompositionTabs {...baseProps()} />);
    const tabs = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="phase-tab"]',
      ),
    );
    expect(tabs.map((t) => t.getAttribute("data-phase"))).toEqual([
      "early",
      "earlyMid",
      "mid",
      "midLate",
      "late",
    ]);
    // Each tab renders BOTH a short and long label (Tailwind hides
    // one per breakpoint) so a textContent dump concatenates them;
    // query the desktop variant + count directly to assert content.
    const longLabels = tabs.map(
      (t) =>
        t
          .querySelector('[data-testid="phase-tab-label-long"]')
          ?.textContent?.trim(),
    );
    const shortLabels = tabs.map(
      (t) =>
        t
          .querySelector('[data-testid="phase-tab-label-short"]')
          ?.textContent?.trim(),
    );
    const counts = tabs.map(
      (t) =>
        t.querySelector('[data-testid="phase-tab-count"]')?.textContent?.trim(),
    );
    expect(longLabels).toEqual([
      "Early",
      "Early/Mid",
      "Mid",
      "Mid/Late",
      "Late",
    ]);
    expect(shortLabels).toEqual(["Early", "E/Mid", "Mid", "M/Late", "Late"]);
    expect(counts).toEqual(["12", "7", "3", "0", "0"]);
  });

  it("starts on the first reached phase and tab click swaps the panel content", () => {
    const { container } = render(<PhaseCompositionTabs {...baseProps()} />);
    const panel = container.querySelector('[data-testid="phase-tab-panel"]');
    expect(panel?.getAttribute("data-active-phase")).toBe("early");

    const cardsBefore = container.querySelectorAll(
      '[data-testid="composition-card"]',
    );
    expect(cardsBefore.length).toBe(2);

    const earlyMidTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="phase-tab"][data-phase="earlyMid"]',
    );
    expect(earlyMidTab).not.toBeNull();
    fireEvent.click(earlyMidTab!);

    expect(panel?.getAttribute("data-active-phase")).toBe("earlyMid");
    const cardsAfter = container.querySelectorAll(
      '[data-testid="composition-card"]',
    );
    expect(cardsAfter.length).toBe(1);
    expect(cardsAfter[0].getAttribute("data-signature-key")).toBe(
      "Zergling|Roach",
    );
  });

  it("disabled tabs do not accept clicks", () => {
    const { container } = render(<PhaseCompositionTabs {...baseProps()} />);
    const panel = container.querySelector('[data-testid="phase-tab-panel"]');
    const lateTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="phase-tab"][data-phase="late"]',
    );
    expect(lateTab).not.toBeNull();
    expect(lateTab!.disabled).toBe(true);
    fireEvent.click(lateTab!);
    // Active phase should not move.
    expect(panel?.getAttribute("data-active-phase")).toBe("early");
  });

  it("invokes onSignatureClick with the matching sampleGameIds on card click", () => {
    const onSignatureClick = vi.fn();
    const { container } = render(
      <PhaseCompositionTabs
        {...baseProps({ onSignatureClick })}
      />,
    );
    const cards = container.querySelectorAll<HTMLLIElement>(
      '[data-testid="composition-card"]',
    );
    expect(cards.length).toBe(2);
    fireEvent.click(cards[0]);
    expect(onSignatureClick).toHaveBeenCalledTimes(1);
    expect(onSignatureClick).toHaveBeenCalledWith(["g1", "g2", "g3"]);
    fireEvent.click(cards[1]);
    expect(onSignatureClick).toHaveBeenLastCalledWith(["g4", "g5"]);
  });

  it("positions tech timeline markers at the correct % offsets", () => {
    const { container } = render(<PhaseCompositionTabs {...baseProps()} />);
    const markers = Array.from(
      container.querySelectorAll('[data-testid="tech-marker"]'),
    );
    const byToken: Record<
      string,
      { median: number; p25: number; p75: number }
    > = {};
    for (const m of markers) {
      const token = m.getAttribute("data-token") ?? "";
      byToken[token] = {
        median: Number(m.getAttribute("data-median-pct")),
        p25: Number(m.getAttribute("data-p25-pct")),
        p75: Number(m.getAttribute("data-p75-pct")),
      };
    }
    // Range across the phase tech is p25=70 → p75=180, span=110.
    // SpawningPool median 80 → (80-70)/110 = 9.09%, p25=0%, p75=(100-70)/110=27.27%
    expect(byToken.SpawningPool.median).toBeCloseTo(9.0909, 3);
    expect(byToken.SpawningPool.p25).toBeCloseTo(0, 4);
    expect(byToken.SpawningPool.p75).toBeCloseTo(27.2727, 3);
    // RoachWarren median 160 → (160-70)/110 = 81.82%, p25=(140-70)/110=63.64%, p75=100%
    expect(byToken.RoachWarren.median).toBeCloseTo(81.8181, 3);
    expect(byToken.RoachWarren.p25).toBeCloseTo(63.6363, 3);
    expect(byToken.RoachWarren.p75).toBeCloseTo(100, 4);
  });

  it("hides the tech timeline when showTechRow is false", () => {
    const { container } = render(
      <PhaseCompositionTabs {...baseProps({ showTechRow: false })} />,
    );
    expect(
      container.querySelector('[data-testid="tech-timeline"]'),
    ).toBeNull();
  });

  it("warns and shows the data-shape regression empty state when signatures are missing on a reached phase", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { container } = render(
        <PhaseCompositionTabs
          {...baseProps({
            sampleSize: { early: 0, earlyMid: 0, mid: 5, midLate: 0, late: 0 },
            perPhase: {
              early: emptyRow(),
              earlyMid: emptyRow(),
              mid: emptyRow(),
              midLate: emptyRow(),
              late: emptyRow(),
            },
          })}
        />,
      );
      expect(container.textContent).toMatch(/Composition data still landing/i);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  describe("theme parity", () => {
    it("renders identically structured DOM in both themes", () => {
      document.documentElement.setAttribute("data-theme", "light");
      const { container: light } = render(
        <PhaseCompositionTabs {...baseProps()} />,
      );
      const lightSnapshot = stripStyles(light.innerHTML);
      cleanup();

      document.documentElement.setAttribute("data-theme", "dark");
      const { container: dark } = render(
        <PhaseCompositionTabs {...baseProps()} />,
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
          <PhaseCompositionTabs {...baseProps()} />,
        );
        const overflowing = Array.from(
          container.querySelectorAll<HTMLElement>("*"),
        ).filter((el) => el.scrollWidth > el.clientWidth + 1);
        expect(overflowing).toEqual([]);
      });
    });
  });
});

/**
 * Strip values that legitimately differ between themes (computed
 * styles, color tokens reflected in inline ``style`` attributes) so
 * snapshots can compare DOM SHAPE while letting the token system swap
 * colors freely.
 */
function stripStyles(html: string): string {
  return html
    .replace(/\sstyle="[^"]*"/g, "")
    .replace(/\sdata-theme="[^"]*"/g, "");
}

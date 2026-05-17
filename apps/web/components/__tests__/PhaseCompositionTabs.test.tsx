import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  PhaseCompositionTabs,
  type PhaseCompositionTabsProps,
  type Phase,
  type PhaseCompositionRow,
  type PhaseStrategyEnvelope,
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

  it("renders per-strategy storyline cards under the active phase when byStrategy is provided", () => {
    const strategy: PhaseStrategyEnvelope = {
      strategy: "Zerg - 3 Base Macro (Hatch First)",
      race: "Z",
      games: 21,
      wins: 12,
      losses: 9,
      winRate: 12 / 21,
      phases: {
        sampleSize: {
          early: 21,
          earlyMid: 21,
          mid: 18,
          midLate: 5,
          late: 2,
        },
        perPhase: {
          early: {
            signatures: [
              {
                key: "Drone|Zergling",
                units: [
                  { token: "Drone", count: 14 },
                  { token: "Zergling", count: 4 },
                ],
                sampleCount: 21,
                wins: 12,
                losses: 9,
                winRate: 12 / 21,
                sampleGameIds: ["g1", "g2"],
              },
            ],
            tech: [
              {
                token: "Hatchery",
                sampleCount: 21,
                medianFirstSeen: 92,
                p25: 80,
                p75: 105,
              },
            ],
            upgrades: [],
          },
          earlyMid: {
            signatures: [
              {
                key: "Roach|Queen",
                units: [
                  { token: "Roach", count: 8 },
                  { token: "Queen", count: 3 },
                ],
                sampleCount: 21,
                wins: 12,
                losses: 9,
                winRate: 12 / 21,
                sampleGameIds: ["g1"],
              },
            ],
            tech: [
              {
                token: "RoachWarren",
                sampleCount: 21,
                medianFirstSeen: 252,
                p25: 230,
                p75: 280,
              },
            ],
            upgrades: [],
          },
          mid: {
            signatures: [
              {
                key: "Hydralisk|Ravager",
                units: [
                  { token: "Hydralisk", count: 12 },
                  { token: "Ravager", count: 4 },
                ],
                sampleCount: 18,
                wins: 10,
                losses: 8,
                winRate: 10 / 18,
                sampleGameIds: ["g1"],
              },
            ],
            tech: [
              {
                token: "HydraliskDen",
                sampleCount: 18,
                medianFirstSeen: 432,
                p25: 410,
                p75: 460,
              },
            ],
            upgrades: [],
          },
          midLate: { signatures: [], tech: [], upgrades: [] },
          late: { signatures: [], tech: [], upgrades: [] },
        },
        finalPhaseDistribution: {
          early: 0,
          earlyMid: 12,
          mid: 7,
          midLate: 2,
          late: 0,
        },
        medianCrossings: {
          earlyMidAt: 120,
          midAt: 300,
          midLateAt: 700,
          lateAt: null,
        },
        durationP95Sec: 720,
        flags: [],
      },
    };
    const { container } = render(
      <PhaseCompositionTabs
        {...baseProps({
          byStrategy: [strategy],
        })}
      />,
    );
    const breakdown = container.querySelector(
      '[data-testid="strategy-breakdown"]',
    );
    expect(breakdown).not.toBeNull();
    const cards = container.querySelectorAll(
      '[data-testid="strategy-card"]',
    );
    expect(cards.length).toBe(1);
    expect(cards[0].getAttribute("data-strategy")).toBe(strategy.strategy);
    expect(cards[0].getAttribute("data-race")).toBe("Z");
    const columns = cards[0].querySelectorAll(
      '[data-testid="strategy-column"]',
    );
    expect(columns.length).toBe(3);
    const labels = Array.from(columns).map((c) =>
      c.getAttribute("data-column"),
    );
    expect(labels).toEqual(["opening", "mid", "late"]);
  });

  it("filters strategy cards to those that reached the active phase", () => {
    const reaches: PhaseStrategyEnvelope = {
      strategy: "Long Macro",
      race: "Z",
      games: 6,
      wins: 4,
      losses: 2,
      winRate: 4 / 6,
      phases: {
        sampleSize: {
          early: 6,
          earlyMid: 6,
          mid: 6,
          midLate: 0,
          late: 0,
        },
        perPhase: {
          early: { signatures: [], tech: [], upgrades: [] },
          earlyMid: { signatures: [], tech: [], upgrades: [] },
          mid: { signatures: [], tech: [], upgrades: [] },
          midLate: { signatures: [], tech: [], upgrades: [] },
          late: { signatures: [], tech: [], upgrades: [] },
        },
        finalPhaseDistribution: {
          early: 0,
          earlyMid: 0,
          mid: 6,
          midLate: 0,
          late: 0,
        },
        medianCrossings: {
          earlyMidAt: 120,
          midAt: 300,
          midLateAt: null,
          lateAt: null,
        },
        durationP95Sec: 540,
        flags: [],
      },
    };
    const doesNotReach: PhaseStrategyEnvelope = {
      ...reaches,
      strategy: "Quick Rush",
      phases: {
        ...reaches.phases,
        sampleSize: {
          early: 3,
          earlyMid: 3,
          mid: 0,
          midLate: 0,
          late: 0,
        },
      },
    };
    const { container } = render(
      <PhaseCompositionTabs
        {...baseProps({
          byStrategy: [reaches, doesNotReach],
          preferredPhase: "mid",
        })}
      />,
    );
    const cards = container.querySelectorAll(
      '[data-testid="strategy-card"]',
    );
    expect(cards.length).toBe(1);
    expect(cards[0].getAttribute("data-strategy")).toBe("Long Macro");
  });

  it("invokes onStrategyOpen with the strategy name on CTA click", () => {
    const onStrategyOpen = vi.fn();
    const env: PhaseStrategyEnvelope = {
      strategy: "Zerg - 3 Base Macro",
      race: "Z",
      games: 4,
      wins: 3,
      losses: 1,
      winRate: 0.75,
      phases: {
        sampleSize: {
          early: 4,
          earlyMid: 4,
          mid: 0,
          midLate: 0,
          late: 0,
        },
        perPhase: {
          early: { signatures: [], tech: [], upgrades: [] },
          earlyMid: { signatures: [], tech: [], upgrades: [] },
          mid: { signatures: [], tech: [], upgrades: [] },
          midLate: { signatures: [], tech: [], upgrades: [] },
          late: { signatures: [], tech: [], upgrades: [] },
        },
        finalPhaseDistribution: {
          early: 0,
          earlyMid: 4,
          mid: 0,
          midLate: 0,
          late: 0,
        },
        medianCrossings: {
          earlyMidAt: 100,
          midAt: null,
          midLateAt: null,
          lateAt: null,
        },
        durationP95Sec: 360,
        flags: [],
      },
    };
    const { container } = render(
      <PhaseCompositionTabs
        {...baseProps({
          byStrategy: [env],
          onStrategyOpen,
        })}
      />,
    );
    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="strategy-open-btn"]',
    );
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(onStrategyOpen).toHaveBeenCalledTimes(1);
    expect(onStrategyOpen).toHaveBeenCalledWith("Zerg - 3 Base Macro");
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

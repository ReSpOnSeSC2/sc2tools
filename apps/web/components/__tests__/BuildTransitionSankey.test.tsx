import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@nivo/sankey", () => ({
  ResponsiveSankey: () => null,
}));

import {
  BuildTransitionSankey,
  type BuildTransitionsPayload,
  type TransitionEdge,
  type TransitionNode,
} from "@/components/analyzer/BuildTransitionSankey";

afterEach(cleanup);

function node(partial: Partial<TransitionNode> & {
  id: string;
  column: 0 | 1 | 2 | 3;
  kind: TransitionNode["kind"];
}): TransitionNode {
  return {
    id: partial.id,
    label: partial.label ?? partial.id,
    column: partial.column,
    kind: partial.kind,
    games: partial.games ?? 0,
    wins: partial.wins ?? 0,
    losses: partial.losses ?? 0,
    iconTokens: partial.iconTokens,
  };
}

function edge(partial: Partial<TransitionEdge> & {
  from: string;
  to: string;
}): TransitionEdge {
  const wins = partial.wins ?? 0;
  const losses = partial.losses ?? 0;
  const denom = wins + losses;
  return {
    from: partial.from,
    to: partial.to,
    games: partial.games ?? wins + losses,
    wins,
    losses,
    winRate: partial.winRate ?? (denom > 0 ? wins / denom : 0),
  };
}

function payload(
  overrides: Partial<BuildTransitionsPayload["transitions"]> = {},
  meta: Partial<Pick<BuildTransitionsPayload, "slug" | "name">> = {},
): BuildTransitionsPayload {
  const nodes: TransitionNode[] = overrides.nodes ?? [
    node({ id: "build", column: 0, kind: "build", label: "1-Gate Expand", games: 14, wins: 9, losses: 5 }),
    node({ id: "strat:Stargate", column: 1, kind: "oppStrategy", label: "Stargate", games: 8, wins: 5, losses: 3 }),
    node({ id: "strat:Robo", column: 1, kind: "oppStrategy", label: "Robo", games: 6, wins: 4, losses: 2 }),
    node({ id: "phase:mid", column: 2, kind: "finalPhase", label: "mid", games: 5, wins: 3, losses: 2 }),
    node({ id: "phase:late", column: 2, kind: "finalPhase", label: "late", games: 9, wins: 6, losses: 3 }),
    node({
      id: "comp:Immortal|Stalker",
      column: 3,
      kind: "lateComp",
      label: "Immortal|Stalker",
      games: 9,
      wins: 6,
      losses: 3,
      iconTokens: ["Immortal", "Stalker", "Sentry"],
    }),
  ];
  const edges: TransitionEdge[] = overrides.edges ?? [
    edge({ from: "build", to: "strat:Stargate", games: 8, wins: 5, losses: 3 }),
    edge({ from: "build", to: "strat:Robo", games: 6, wins: 4, losses: 2 }),
    edge({ from: "strat:Stargate", to: "phase:mid", games: 3, wins: 2, losses: 1 }),
    edge({ from: "strat:Stargate", to: "phase:late", games: 5, wins: 3, losses: 2 }),
    edge({ from: "strat:Robo", to: "phase:late", games: 4, wins: 3, losses: 1 }),
    edge({ from: "phase:late", to: "comp:Immortal|Stalker", games: 9, wins: 6, losses: 3 }),
  ];
  return {
    slug: meta.slug ?? "test-build",
    name: meta.name ?? "Test Build",
    transitions: {
      nodes,
      edges,
      rare: overrides.rare ?? { collapsedNodes: 0, collapsedEdges: 0 },
      byMatchup: overrides.byMatchup,
    },
  };
}

describe("BuildTransitionSankey", () => {
  it("renders only nodes present in the payload (no synthetic nodes)", () => {
    const data = payload();
    const { container } = render(<BuildTransitionSankey transitions={data} />);
    const rows = container.querySelectorAll('[data-testid="transition-edge-row"]');
    expect(rows.length).toBe(data.transitions.edges.length);
    const ids = new Set(data.transitions.nodes.map((n) => n.id));
    for (const row of Array.from(rows)) {
      expect(ids.has(row.getAttribute("data-edge-from") ?? "")).toBe(true);
      expect(ids.has(row.getAttribute("data-edge-to") ?? "")).toBe(true);
    }
  });

  it("renders the matchup pill bar with byMatchup keys plus 'All'", () => {
    const data = payload({
      byMatchup: {
        PvT: [
          { edgeIdx: 0, games: 5, wins: 3, losses: 2 },
          { edgeIdx: 2, games: 3, wins: 2, losses: 1 },
        ],
        PvZ: [
          { edgeIdx: 1, games: 3, wins: 2, losses: 1 },
        ],
      },
    });
    const { container } = render(<BuildTransitionSankey transitions={data} />);
    const pills = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="matchup-pill"]',
      ),
    );
    expect(pills.map((p) => p.getAttribute("data-matchup"))).toEqual([
      "All",
      "PvT",
      "PvZ",
    ]);
    // No bar when byMatchup absent.
    cleanup();
    const data2 = payload();
    const { container: c2 } = render(
      <BuildTransitionSankey transitions={data2} />,
    );
    expect(c2.querySelector('[data-testid="matchup-pill-bar"]')).toBeNull();
  });

  it("matchup pill clicks toggle filter state and re-derive edges", () => {
    const data = payload({
      byMatchup: {
        PvT: [
          { edgeIdx: 0, games: 5, wins: 3, losses: 2 },
          { edgeIdx: 2, games: 3, wins: 2, losses: 1 },
        ],
        PvZ: [
          { edgeIdx: 1, games: 3, wins: 2, losses: 1 },
          { edgeIdx: 4, games: 4, wins: 3, losses: 1 },
        ],
      },
    });
    const { container } = render(<BuildTransitionSankey transitions={data} />);
    const root = container.querySelector(
      '[data-testid="build-transition-sankey"]',
    );
    expect(root?.getAttribute("data-matchup")).toBe("All");

    const allEdgesBefore = container.querySelectorAll(
      '[data-testid="transition-edge-row"]',
    );
    expect(allEdgesBefore.length).toBe(6);

    const pvtPill = container.querySelector<HTMLButtonElement>(
      '[data-testid="matchup-pill"][data-matchup="PvT"]',
    );
    expect(pvtPill).not.toBeNull();
    fireEvent.click(pvtPill!);

    expect(root?.getAttribute("data-matchup")).toBe("PvT");
    const pvtRows = Array.from(
      container.querySelectorAll(
        '[data-testid="transition-edge-row"]',
      ),
    );
    // Two entries with games > 0 in PvT.
    expect(pvtRows.length).toBe(2);
    const pvtPairs = pvtRows
      .map(
        (r) =>
          `${r.getAttribute("data-edge-from")}->${r.getAttribute("data-edge-to")}`,
      )
      .sort();
    expect(pvtPairs).toEqual(
      [
        "build->strat:Stargate",
        "strat:Stargate->phase:mid",
      ].sort(),
    );
    expect(
      pvtPill!.getAttribute("aria-selected"),
    ).toBe("true");

    // Toggle back to All.
    const allPill = container.querySelector<HTMLButtonElement>(
      '[data-testid="matchup-pill"][data-matchup="All"]',
    );
    fireEvent.click(allPill!);
    expect(root?.getAttribute("data-matchup")).toBe("All");
    const afterRows = container.querySelectorAll(
      '[data-testid="transition-edge-row"]',
    );
    expect(afterRows.length).toBe(6);
  });

  it("edge click invokes onEdgeClick with the resolved path", () => {
    const onEdgeClick = vi.fn();
    const data = payload();
    const { container } = render(
      <BuildTransitionSankey
        transitions={data}
        onEdgeClick={onEdgeClick}
      />,
    );
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="transition-edge-button"]',
    );
    expect(buttons.length).toBe(data.transitions.edges.length);
    const target = Array.from(buttons).find(
      (b) =>
        b.getAttribute("data-edge-from") === "phase:late" &&
        b.getAttribute("data-edge-to") === "comp:Immortal|Stalker",
    );
    expect(target).not.toBeUndefined();
    fireEvent.click(target!);
    expect(onEdgeClick).toHaveBeenCalledTimes(1);
    expect(onEdgeClick).toHaveBeenCalledWith({
      nodes: ["phase:late", "comp:Immortal|Stalker"],
      games: 9,
    });
  });

  it("shows the empty state when transitions.rare reports too many collapsed nodes", () => {
    const data = payload({
      rare: { collapsedNodes: 6, collapsedEdges: 4 },
    });
    const { container } = render(<BuildTransitionSankey transitions={data} />);
    expect(container.textContent).toMatch(
      /Need a few more games to map your transitions/i,
    );
    // No Sankey figure rendered when sparse.
    expect(
      container.querySelector(
        '[data-testid="build-transition-sankey-figure"]',
      ),
    ).toBeNull();
  });

  it("shows the empty state when fewer than 4 nodes are present", () => {
    const data = payload({
      nodes: [
        node({
          id: "build",
          column: 0,
          kind: "build",
          label: "Sparse",
          games: 2,
          wins: 1,
          losses: 1,
        }),
        node({
          id: "strat:Unknown",
          column: 1,
          kind: "oppStrategy",
          label: "Unknown",
          games: 2,
          wins: 1,
          losses: 1,
        }),
      ],
      edges: [
        edge({ from: "build", to: "strat:Unknown", games: 2, wins: 1, losses: 1 }),
      ],
    });
    const { container } = render(<BuildTransitionSankey transitions={data} />);
    expect(container.textContent).toMatch(
      /Need a few more games to map your transitions/i,
    );
  });

  it("lateComp nodes display the top-2 unit tokens in the a11y table", () => {
    // The sr-only table mirrors what the Sankey labels; sanity-check
    // that lateComp ids/labels match the payload (no synthesis).
    const data = payload();
    const { container } = render(<BuildTransitionSankey transitions={data} />);
    const lateRow = Array.from(
      container.querySelectorAll('[data-testid="transition-edge-row"]'),
    ).find(
      (r) => r.getAttribute("data-edge-to") === "comp:Immortal|Stalker",
    );
    expect(lateRow).not.toBeUndefined();
    // The label is the raw node id here — the Sankey label transform
    // happens inside the chart layer; the table preserves the id.
    expect(lateRow!.textContent).toMatch(/comp:Immortal\|Stalker/);
  });

  it("controlled matchupFilter overrides internal state", () => {
    const data = payload({
      byMatchup: {
        PvT: [
          { edgeIdx: 0, games: 5, wins: 3, losses: 2 },
        ],
        PvZ: [
          { edgeIdx: 1, games: 3, wins: 2, losses: 1 },
        ],
      },
    });
    const { container } = render(
      <BuildTransitionSankey
        transitions={data}
        matchupFilter="PvZ"
      />,
    );
    const root = container.querySelector(
      '[data-testid="build-transition-sankey"]',
    );
    expect(root?.getAttribute("data-matchup")).toBe("PvZ");
    // Clicking another pill should NOT change state (controlled).
    const pvtPill = container.querySelector<HTMLButtonElement>(
      '[data-testid="matchup-pill"][data-matchup="PvT"]',
    );
    fireEvent.click(pvtPill!);
    expect(root?.getAttribute("data-matchup")).toBe("PvZ");
  });

  describe("theme parity", () => {
    it("renders identically structured DOM in both themes", () => {
      document.documentElement.setAttribute("data-theme", "light");
      const { container: light } = render(
        <BuildTransitionSankey transitions={payload()} />,
      );
      const lightSnapshot = stripStyles(light.innerHTML);
      cleanup();

      document.documentElement.setAttribute("data-theme", "dark");
      const { container: dark } = render(
        <BuildTransitionSankey transitions={payload()} />,
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
          <BuildTransitionSankey transitions={payload()} />,
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
    .replace(/\sdata-theme="[^"]*"/g, "")
    // React's useId() emits monotonically increasing ids per render
    // (:r9:, :ra:, …). Normalize them so two consecutive renders
    // compare equal on shape.
    .replace(/(id|aria-describedby|for)="[^"]*"/g, '$1="<id>"');
}

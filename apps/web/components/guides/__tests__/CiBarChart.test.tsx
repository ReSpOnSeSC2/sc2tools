import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CiBarChart, ciBarRowLabel, type CiBarDatum } from "@/components/guides/CiBarChart";
import { FIXTURE_BUILD_PUBLISHED } from "@/lib/guides/__fixtures__";

afterEach(cleanup);

const LEAGUE_DATA: CiBarDatum[] = FIXTURE_BUILD_PUBLISHED.bands.league.map((cell) => ({
  key: `league-${cell.value}`,
  label: cell.label,
  winRate: cell.winRate,
  ci: cell.ci,
  games: cell.games,
  users: cell.users,
}));

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

describe("CiBarChart", () => {
  it("renders one bar per datum with a full aria label and n label", () => {
    render(<CiBarChart title="Win rate by opponent league" data={LEAGUE_DATA} />);
    const list = screen.getByRole("list", { name: "Win rate by opponent league" });
    expect(list).toBeTruthy();
    expect(screen.getAllByTestId("ci-bar")).toHaveLength(LEAGUE_DATA.length);
    const diamond = LEAGUE_DATA[1];
    const row = screen.getByLabelText(ciBarRowLabel(diamond));
    const label = row.getAttribute("aria-label") ?? "";
    expect(label).toContain("Diamond");
    expect(label).toContain(pct(diamond.winRate));
    expect(label).toContain(`${diamond.games} games`);
    expect(label).toContain(`${diamond.users} players`);
    expect(row.textContent).toContain(`n=${diamond.games}`);
  });

  it("sizes each bar from the payload win rate", () => {
    render(<CiBarChart title="Bands" data={LEAGUE_DATA} />);
    const widths = screen.getAllByTestId("ci-bar").map((bar) => bar.getAttribute("width"));
    expect(widths).toEqual(LEAGUE_DATA.map((d) => `${(d.winRate * 100).toFixed(2)}%`));
  });

  it("shows a tooltip on focus, moves with arrow keys and hides on Escape", () => {
    render(<CiBarChart title="Bands" data={LEAGUE_DATA} />);
    const rows = screen.getAllByRole("button");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(rows[0]);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain(LEAGUE_DATA[0].label);
    expect(rows[0].getAttribute("aria-describedby")).toBe(tooltip.id);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("ships an sr-only data table with every value", () => {
    render(<CiBarChart title="Bands" data={LEAGUE_DATA} />);
    const table = screen.getByRole("table");
    expect(table.className).toContain("sr-only");
    for (const datum of LEAGUE_DATA) {
      expect(table.textContent).toContain(datum.label);
      expect(table.textContent).toContain(pct(datum.winRate));
    }
  });

  it("keeps one Tab stop, moves it with arrows/Home/End and toggles a pinned tooltip", () => {
    render(<CiBarChart title="Bands" data={LEAGUE_DATA} />);
    const rows = screen.getAllByRole("button");
    const tabStops = () => rows.filter((row) => row.tabIndex === 0);
    expect(tabStops()).toEqual([rows[0]]);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "End" });
    expect(document.activeElement).toBe(rows.at(-1));
    expect(tabStops()).toEqual([rows.at(-1)]);
    fireEvent.keyDown(rows.at(-1)!, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(tabStops()).toEqual([rows[1]]);
    fireEvent.keyDown(rows[1], { key: "Enter" });
    expect(rows[1].getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(rows[1]);
    expect(screen.getByRole("tooltip").textContent).toContain(LEAGUE_DATA[1].label);
    fireEvent.keyDown(rows[1], { key: "Escape" });
    expect(rows[1].getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(rows[0]);
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(rows[0], { key: " " });
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(rows[0], { key: " " });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("distinguishes all verdicts without relying on bar colour", () => {
    const data = [
      { ...LEAGUE_DATA[0], key: "win", winRate: 0.7, ci: { low: 0.6, high: 0.8 } },
      { ...LEAGUE_DATA[0], key: "even", winRate: 0.5, ci: { low: 0.4, high: 0.6 } },
      { ...LEAGUE_DATA[0], key: "loss", winRate: 0.3, ci: { low: 0.2, high: 0.4 } },
    ];
    const { container } = render(<CiBarChart title="Verdicts" data={data} />);
    const rows = screen.getAllByRole("button");
    expect(rows.map((row) => row.textContent?.match(/[▲●▼]/)?.[0])).toEqual(["▲", "●", "▼"]);
    expect(rows[0].getAttribute("aria-label")).toContain("clearly above 50%");
    const bar = screen.getAllByTestId("ci-bar")[1];
    const id = bar.getAttribute("fill")!.slice(5, -1);
    expect(container.querySelector("pattern")?.id).not.toBe("");
    expect(document.getElementById(id)?.tagName.toLowerCase()).toBe("pattern");
    expect(screen.getByText(/hatched: too close to call/)).toBeTruthy();
  });

  it("renders nothing without data", () => {
    const { container } = render(<CiBarChart title="Empty" data={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

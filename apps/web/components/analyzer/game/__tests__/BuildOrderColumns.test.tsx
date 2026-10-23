import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { buildLogToEvents } from "@/lib/build-events";
import { BuildOrderColumns } from "../BuildOrderColumns";

// next/image needs the Next runtime; a bare <img> is equivalent here.
vi.mock("next/image", () => ({
  default: (props: { src?: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={String(props.src ?? "")} alt={props.alt ?? ""} />
  ),
}));

afterEach(() => cleanup());

describe("BuildOrderColumns", () => {
  it("uses canonical entities when filtering prefixed or spaced workers and supply buildings", () => {
    render(<BuildOrderColumns myEvents={[{ time: 10, name: "TrainSCV" }, { time: 20, name: "BuildSupplyDepot" }, { time: 30, name: "Supply Depot" }]} workspace={{ myMeta: { title: "Mine", sourceUrl: "/g" }, oppMeta: { title: "Theirs", sourceUrl: "/g" } }} />);
    const mine = within(screen.getByTestId("build-column-me"));
    expect(mine.queryByTitle("TrainSCV")).toBeNull(); expect(mine.getByTitle("BuildSupplyDepot")).toBeTruthy(); expect(mine.getByTitle("Supply Depot")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show workers" })); expect(mine.getByTitle("TrainSCV")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Supply buildings" })); expect(mine.queryByTitle("BuildSupplyDepot")).toBeNull(); expect(mine.queryByTitle("Supply Depot")).toBeNull();
  });
  it("filters both workspace columns and shows prior measured supply without future guesses", () => {
    const seek = vi.fn();
    render(<BuildOrderColumns onSeek={seek} myEvents={[{ time: 1, name: "Pylon" }, { time: 30, name: "Probe" }, { time: 40, name: "Gateway" }, { time: 40, name: "Zealot", supply: 19 }]} oppEvents={[{ time: 40, name: "Marine" }]} workspace={{ myMeta: { title: "Mine", sourceUrl: "/g" }, oppMeta: { title: "Theirs", sourceUrl: "/g" }, myStats: [{ time: 20, food_used: 17 }], oppStats: [{ time: 60, food_used: 25 }] }} />);
    const mine = within(screen.getByTestId("build-column-me")), theirs = within(screen.getByTestId("build-column-opp"));
    expect(mine.queryByText("Probe")).toBeNull(); expect(mine.getByText("Pylon")).toBeTruthy(); expect(mine.getByText("≈17")).toBeTruthy(); expect(mine.getByText("19")).toBeTruthy();
    expect(theirs.getByText("—")).toBeTruthy();
    fireEvent.click(mine.getByRole("button", { name: "Jump to 0:40 Gateway" })); expect(seek).toHaveBeenCalledWith(40);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show workers" })); expect(mine.getByText("Probe")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Supply buildings" })); expect(mine.queryByText("Pylon")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter steps" }), { target: { value: "Marine" } });
    expect(mine.queryByText("Gateway")).toBeNull(); expect(mine.getByText("No steps match these filters.")).toBeTruthy(); expect(theirs.getByText("Marine")).toBeTruthy();
  });
  it("parses [m:ss] build-log lines into two labelled columns", () => {
    const myEvents = buildLogToEvents(
      ["[0:17] SpawningPool", "[1:05] Zergling", "[2:30] RoachWarren"],
      "Zerg",
    );
    const oppEvents = buildLogToEvents(["[0:20] Barracks"], "Terran");

    render(
      <BuildOrderColumns
        myEvents={myEvents}
        oppEvents={oppEvents}
        myLabel="Pool First"
        oppLabel="Terran - 2 Rax"
        myStatus="ok"
        oppStatus="ok"
      />,
    );

    const mine = within(screen.getByTestId("build-column-me"));
    expect(mine.getAllByText("You — Pool First")).toHaveLength(2);
    expect(mine.getByRole("button", { name: "You — Pool First" }).className).toContain("md:hidden");
    expect(mine.getAllByRole("heading", { name: "You — Pool First" }).some((heading) => heading.className.includes("md:flex"))).toBe(true);
    // Time chips keep the m:ss shape; names are humanized.
    expect(mine.getByText("0:17")).toBeTruthy();
    expect(mine.getByText("Spawning Pool")).toBeTruthy();
    expect(mine.getByText("1:05")).toBeTruthy();
    expect(mine.getByText("Zergling")).toBeTruthy();
    expect(mine.getByText("Roach Warren")).toBeTruthy();

    const theirs = within(screen.getByTestId("build-column-opp"));
    expect(theirs.getAllByText("Opponent — Terran - 2 Rax")).toHaveLength(2);
    expect(theirs.getByText("0:20")).toBeTruthy();
    expect(theirs.getByText("Barracks")).toBeTruthy();
    // My rows never leak into the opponent column.
    expect(theirs.queryByText("Spawning Pool")).toBeNull();
  });

  it("skips malformed lines instead of rendering blank rows", () => {
    const events = buildLogToEvents(
      ["garbage line", "[1:00] Hatchery", "[xx:yy] Nope"],
      "Zerg",
    );
    render(<BuildOrderColumns myEvents={events} oppEvents={[]} />);
    const mine = within(screen.getByTestId("build-column-me"));
    expect(mine.getByText("Hatchery")).toBeTruthy();
    expect(mine.queryByText(/garbage/)).toBeNull();
    expect(mine.queryByText(/Nope/)).toBeNull();
  });

  it("explains a side the agent has not extracted yet", () => {
    render(
      <BuildOrderColumns
        myEvents={buildLogToEvents(["[0:30] Pylon"], "Protoss")}
        oppEvents={[]}
        oppStatus="not_extracted"
      />,
    );
    const theirs = within(screen.getByTestId("build-column-opp"));
    expect(
      theirs.getByText(/hasn't extracted this build log yet/i),
    ).toBeTruthy();
  });
});

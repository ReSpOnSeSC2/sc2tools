import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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
    expect(mine.getByText("You — Pool First")).toBeTruthy();
    // Time chips keep the m:ss shape; names are humanized.
    expect(mine.getByText("0:17")).toBeTruthy();
    expect(mine.getByText("Spawning Pool")).toBeTruthy();
    expect(mine.getByText("1:05")).toBeTruthy();
    expect(mine.getByText("Zergling")).toBeTruthy();
    expect(mine.getByText("Roach Warren")).toBeTruthy();

    const theirs = within(screen.getByTestId("build-column-opp"));
    expect(theirs.getByText("Opponent — Terran - 2 Rax")).toBeTruthy();
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { CasualtySnapshot } from "../CasualtySnapshot";
import type { CasualtyEvent } from "../MacroBreakdownPanel.types";

afterEach(cleanup);

// Deliberately unsorted: replay event order must not leak future deaths into
// the selected moment or prevent an earlier event from being counted.
const events: CasualtyEvent[] = [
  { time: 61, owner: "opp", killer: "me", category: "units", name: "Marauder" },
  { time: 10, owner: "opp", killer: "me", category: "units", name: "Marine" },
  { time: 20, owner: "me", killer: "opp", category: "workers", name: "Probe" },
  { time: 25, owner: "opp", killer: "me", category: "workers", name: "SCV" },
  { time: 30, owner: "me", killer: "opp", category: "buildings", name: "Gateway" },
  { time: 40, owner: "opp", killer: null, category: "buildings", name: "Barracks" },
  { time: 50, owner: "me", killer: "me", category: "units", name: "Zealot" },
  { time: 60, owner: "opp", killer: "me", category: "buildings", name: "Factory" },
];

function tableAt(clock: string) {
  return screen.getByRole("table", { name: `Kills and losses at ${clock}` });
}

function rowCounts(table: HTMLElement, category: string) {
  const row = within(table).getByRole("row", { name: new RegExp(`^${category}\\b`) });
  return within(row).getAllByRole("cell").map((cell) => cell.textContent);
}

function categories() {
  return screen.getByRole("group", { name: "Casualty categories" });
}

function categoryButton(name: string) {
  return within(categories()).getByRole("button", { name: `Show ${name}` });
}

describe("CasualtySnapshot", () => {
  it("shows disjoint counts at the selected second and credits only enemy kills", () => {
    const view = render(<CasualtySnapshot events={events} time={30} workersOnly={false} />);

    expect(screen.getByRole("heading", { name: "Killed & lost" })).toBeTruthy();
    const table = tableAt("0:30");
    expect(rowCounts(table, "Units")).toEqual(["1", "0", "0", "1"]);
    expect(rowCounts(table, "Buildings")).toEqual(["0", "1", "1", "0"]);
    expect(rowCounts(table, "Workers")).toEqual(["1", "1", "1", "1"]);

    view.rerender(<CasualtySnapshot events={events} time={60} workersOnly={false} />);
    const later = tableAt("1:00");
    // Friendly fire still loses a unit, but awards neither player a kill.
    expect(rowCounts(later, "Units")).toEqual(["1", "1", "0", "1"]);
    // An unknown killer still contributes to the victim's losses.
    expect(rowCounts(later, "Buildings")).toEqual(["1", "1", "1", "2"]);
    expect(rowCounts(later, "Workers")).toEqual(["1", "1", "1", "1"]);

    view.rerender(<CasualtySnapshot events={events} time={9} workersOnly={false} />);
    for (const category of ["Units", "Buildings", "Workers"]) {
      expect(rowCounts(tableAt("0:09"), category)).toEqual(["0", "0", "0", "0"]);
    }
  });

  it("lets every army category be independently hidden and restored", () => {
    render(<CasualtySnapshot events={events} time={60} workersOnly={false} />);

    for (const name of ["Units", "Buildings", "Workers"]) {
      expect(categoryButton(name).getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(categoryButton(name));
      expect(categoryButton(name).getAttribute("aria-pressed")).toBe("false");
      const table = screen.queryByRole("table");
      if (table) {
        expect(within(table).queryByRole("row", { name: new RegExp(`^${name}\\b`) })).toBeNull();
      }
    }

    expect(screen.getByText("Select a category to see kills and losses.")).toBeTruthy();
    fireEvent.click(categoryButton("Buildings"));
    expect(categoryButton("Buildings").getAttribute("aria-pressed")).toBe("true");
    expect(rowCounts(tableAt("1:00"), "Buildings")).toEqual(["1", "1", "1", "2"]);
    expect(within(tableAt("1:00")).queryByRole("row", { name: /^Units\b/ })).toBeNull();
    expect(within(tableAt("1:00")).queryByRole("row", { name: /^Workers\b/ })).toBeNull();
    expect(screen.queryByText("Select a category to see kills and losses.")).toBeNull();
  });

  it("shows only workers in worker mode and retains the army category choices", () => {
    const view = render(<CasualtySnapshot events={events} time={60} workersOnly={false} />);
    fireEvent.click(categoryButton("Buildings"));
    fireEvent.click(categoryButton("Workers"));

    view.rerender(<CasualtySnapshot events={events} time={60} workersOnly />);
    expect(screen.queryByRole("group", { name: "Casualty categories" })).toBeNull();
    const workers = tableAt("1:00");
    expect(rowCounts(workers, "Workers")).toEqual(["1", "1", "1", "1"]);
    expect(within(workers).queryByRole("row", { name: /^Units\b/ })).toBeNull();
    expect(within(workers).queryByRole("row", { name: /^Buildings\b/ })).toBeNull();

    view.rerender(<CasualtySnapshot events={events} time={60} workersOnly={false} />);
    expect(categoryButton("Units").getAttribute("aria-pressed")).toBe("true");
    expect(categoryButton("Buildings").getAttribute("aria-pressed")).toBe("false");
    expect(categoryButton("Workers").getAttribute("aria-pressed")).toBe("false");
    expect(rowCounts(tableAt("1:00"), "Units")).toEqual(["1", "1", "0", "1"]);
  });

  it("distinguishes unavailable replay details from tracked zero deaths", () => {
    const view = render(<CasualtySnapshot time={60} workersOnly={false} />);
    const message = "Kill and loss details are unavailable for this replay. Re-analyze it to add them.";
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();

    view.rerender(<CasualtySnapshot events={[]} time={60} workersOnly={false} />);
    expect(screen.queryByText(message)).toBeNull();
    for (const category of ["Units", "Buildings", "Workers"]) {
      expect(rowCounts(tableAt("1:00"), category)).toEqual(["0", "0", "0", "0"]);
    }
  });

  it("requests reanalysis for missing details and disables repeat requests while pending", () => {
    const onRecompute = vi.fn();
    const view = render(
      <CasualtySnapshot time={60} workersOnly={false} onRecompute={onRecompute} />,
    );
    const button = screen.getByRole("button", { name: "Re-analyze replay" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onRecompute).toHaveBeenCalledTimes(1);

    view.rerender(
      <CasualtySnapshot time={60} workersOnly={false} onRecompute={onRecompute} recomputing />,
    );
    const pending = screen.getByRole("button", { name: "Requesting…" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect(pending.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(pending);
    expect(onRecompute).toHaveBeenCalledTimes(1);

    view.rerender(
      <CasualtySnapshot events={[]} time={60} workersOnly={false} onRecompute={onRecompute} />,
    );
    expect(screen.queryByRole("button", { name: "Re-analyze replay" })).toBeNull();
    expect(tableAt("1:00")).toBeTruthy();
  });
});

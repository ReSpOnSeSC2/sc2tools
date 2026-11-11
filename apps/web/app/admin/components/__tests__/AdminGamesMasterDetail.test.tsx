import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { AdminGamesMasterDetail } from "../AdminGamesMasterDetail";
import { OpponentSummaryStrip } from "../OpponentSummaryStrip";
import { ResultBadge } from "../ResultBadge";
import { decidedWinRate, resultOf } from "../adminResult";
import type { AdminGameDetailGame } from "../AdminGameDetail";

vi.mock("../AdminGameDetail", () => ({ fmtDate: () => "date", fmtDuration: (sec: number | null) => (sec ? `${Math.floor(sec / 60)}:00` : "—") }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const game = (index: number, result: string | null, map: string | null = `Map ${index}`): AdminGameDetailGame => ({
  gameId: `game-${index}`, date: "2026-10-28T12:00:00Z", result, myRace: "Protoss", map, durationSec: 600,
  myMmr: null, macroScore: null, opponent: { displayName: "Rival", race: "Zerg", mmr: null },
});
const GAMES = [game(0, "Victory", "Alcyone"), game(1, "Tie"), game(2, "Undecided", null), game(3, "Defeat")];

function Harness({ initial = null as string | null }) {
  const [selected, setSelected] = useState<string | null>(initial);
  return <>
    <input aria-label="Outside search" />
    <AdminGamesMasterDetail games={GAMES} gameKey={(g) => g.gameId} selectedKey={selected} onSelect={(g) => setSelected(g.gameId)}
      label="Games" status="4 games" pagination={null} placeholder="Pick a game"
      filters={<select aria-label="Map filter"><option>All</option></select>}
      detail={selected ? <p>Detail for {selected}</p> : null} />
  </>;
}
const current = () => document.querySelector("[aria-current='true']")?.getAttribute("data-game-key") ?? null;
const live = () => document.querySelector("[aria-live='polite']")?.textContent;

describe("resultOf and ResultBadge", () => {
  it.each([["Victory", "win"], [" win ", "win"], ["Defeat", "loss"], ["LOSS", "loss"], ["Tie", "tie"], ["draw", "tie"],
    ["Undecided", "unknown"], [null, "unknown"], [undefined, "unknown"], ["", "unknown"]] as const)("%s is %s", (raw, cls) => {
    expect(resultOf(raw)).toBe(cls);
  });
  it("never shows Loss for a tie or an unknown, including pre-classified badges", () => {
    render(<><ResultBadge cls="tie" /><ResultBadge cls="unknown" /><ResultBadge result="Undecided" /></>);
    expect(screen.queryByText("Loss")).toBeNull();
    expect(screen.getByText("Tie")).toBeTruthy();
    expect(screen.getAllByText("Result not recorded")).toHaveLength(2);
  });
  it("rates decided games only", () => {
    expect(decidedWinRate(3, 1)).toBe(0.75);
    expect(decidedWinRate(0, 0)).toBeNull();
  });
});

describe("AdminGamesMasterDetail keyboard selection", () => {
  it("j / ArrowDown select the next game and k / ArrowUp the previous, announcing each", () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(current()).toBe("game-0");
    expect(live()).toBe("Game 1 of 4: Victory on Alcyone");
    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "j" });
    expect(current()).toBe("game-2");
    expect(live()).toBe("Game 3 of 4: Result not recorded on an unknown map");
    const row = screen.getByRole("button", { name: /Map 1/ });
    row.focus();
    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect(current()).toBe("game-2");
    expect(document.activeElement?.getAttribute("data-game-key")).toBe("game-2");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(current()).toBe("game-1");
    expect(live()).toBe("Game 2 of 4: Tie on Map 1");
    fireEvent.keyDown(document.body, { key: "k" });
    fireEvent.keyDown(document.body, { key: "k" });
    expect(current()).toBe("game-0");
  });

  it("ignores shortcuts in inputs, selects and with modifiers; arrows outside the list keep scrolling", () => {
    render(<Harness initial="game-1" />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Outside search" }), { key: "j" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Map filter" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Map filter" }), { key: "k" });
    fireEvent.keyDown(document.body, { key: "j", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(current()).toBe("game-1");
    fireEvent.keyDown(screen.getByText("Detail for game-1"), { key: "j" });
    expect(current()).toBe("game-1");
  });

  it("marks only the selected game with aria-current and moves focus to the detail on Enter", async () => {
    render(<Harness initial="game-3" />);
    expect(document.querySelectorAll("[aria-current]")).toHaveLength(1);
    expect(current()).toBe("game-3");
    const selected = screen.getByRole("button", { name: /Map 3/ });
    selected.focus();
    fireEvent.keyDown(selected, { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Selected game" }));
    const other = screen.getByRole("button", { name: /Map 1/ });
    other.focus();
    await act(async () => { fireEvent.keyDown(other, { key: "Enter" }); });
    expect(current()).toBe("game-1");
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Selected game" }));
    expect(screen.getByText("Detail for game-1")).toBeTruthy();
  });
});

it("moves focus to the detail when a keyboard selection hides the list on a phone", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  render(<Harness />);
  const row = screen.getByRole("button", { name: /Alcyone/ });
  row.focus();
  fireEvent.keyDown(row, { key: "ArrowDown" });
  expect(current()).toBe("game-1");
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "Selected game" }));
});

describe("OpponentSummaryStrip", () => {
  const summary = { wins: 3, losses: 1, ties: 2, unknown: 1, avgDurationSec: 754,
    maps: [{ map: "Alcyone", games: 4, wins: 2, losses: 1, ties: 1 }], mapOptions: ["Alcyone"],
    last10: ["win", "tie", "loss", "unknown"] as const };
  it("shows W–L–T, a decided-only win rate, average length, maps and the last results", () => {
    render(<OpponentSummaryStrip summary={{ ...summary, last10: [...summary.last10] }} />);
    expect(screen.getByText("3–1–2")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText(/4 decided games · Small sample/)).toBeTruthy();
    expect(screen.getByText("12:00")).toBeTruthy();
    expect(screen.getByText("Alcyone").parentElement?.textContent).toBe("Alcyone 2–1–1");
    expect(screen.getAllByRole("listitem").filter((item) => item.closest("ol"))).toHaveLength(4);
    expect(screen.queryByText("Loss")).toBeTruthy();
    expect(screen.getAllByText("Result not recorded")).toHaveLength(1);
  });
  it("drops the small-sample hint at five decided games and shows a dash with none", () => {
    const { rerender } = render(<OpponentSummaryStrip summary={{ ...summary, wins: 4, last10: [] }} />);
    expect(screen.getByText("5 decided games")).toBeTruthy();
    rerender(<OpponentSummaryStrip summary={{ ...summary, wins: 0, losses: 0, last10: [] }} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

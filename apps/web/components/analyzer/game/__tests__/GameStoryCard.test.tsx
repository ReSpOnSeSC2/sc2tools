import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GameStoryCard } from "../GameStoryCard";
import { FightLedger } from "../FightLedger";
import { STORY_INPUT } from "./gameStoryUiFixtures";
import type { StoryFight } from "@/lib/gameStory";

vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
afterEach(cleanup);

describe("Game story consumer", () => {
  it("seeks the shared clock from peak, overtake, fight counts, blocks, swings and a winning game's leak", () => {
    const seek = vi.fn();
    render(<GameStoryCard input={STORY_INPUT} onSeek={seek} />);
    expect(screen.getByRole("heading", { name: "Game story" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Still cost you" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Peak army lead.*1:00/ }));
    fireEvent.click(screen.getByRole("button", { name: /Overtook in workers.*0:30/ }));
    fireEvent.click(screen.getByRole("button", { name: /1 fight won.*3:10/ }));
    fireEvent.click(screen.getByRole("button", { name: /1 fight lost.*5:00/ }));
    fireEvent.click(screen.getByRole("button", { name: /15s supply blocked.*1:10/ }));
    fireEvent.click(screen.getByRole("button", { name: "Watch leak at 1:15" }));
    const swing = screen.getAllByRole("button", { name: /Largest swing/ })[0];
    fireEvent.click(swing);
    expect(seek.mock.calls.slice(0, 6).map(call => call[0])).toEqual([60, 30, 190, 300, 70, 75]);
    expect(seek.mock.calls[6][0]).toBeGreaterThanOrEqual(30);
    const cards = within(screen.getByTestId("fight-ledger-cards"));
    fireEvent.click(cards.getByRole("button", { name: "Watch fight at 3:10" }));
    expect(seek).toHaveBeenLastCalledWith(190);
    expect(screen.getByRole("img", { name: /Relative lead.*Above the center/ })).toBeTruthy();
    expect(screen.getByText(/not a win probability/)).toBeTruthy();
  });

  it("keeps missing prices and supply unknown, with exact known costs and unit counts", () => {
    render(<GameStoryCard input={STORY_INPUT} onSeek={vi.fn()} />);
    const cards = within(screen.getByTestId("fight-ledger-cards"));
    expect(cards.getAllByText("50 minerals · 0 gas").length).toBe(3);
    expect(cards.getAllByText("1 Marine").length).toBe(3);
    expect(cards.getByText("Trade unknown · missing prices")).toBeTruthy();
    expect(cards.getByText(/Supply unmeasured.*1 unpriced/)).toBeTruthy();
    expect(cards.getByText("1 Unknown Fixture Unit")).toBeTruthy();
    expect(within(screen.getByTestId("fight-ledger-table")).getByRole("table")).toBeTruthy();
  });

  it("uses the same story for ties and drops the entire empty card", () => {
    const availability = vi.fn();
    const { rerender } = render(<GameStoryCard input={{ ...STORY_INPUT, result: "Tie" }} onSeek={vi.fn()} onAvailabilityChange={availability} />);
    expect(screen.getByRole("heading", { name: "Game story" })).toBeTruthy();
    expect(screen.queryByText("Still cost you")).toBeNull();
    rerender(<GameStoryCard input={{ gameId: "empty", result: "Tie", casualtyEvents: [] }} onSeek={vi.fn()} onAvailabilityChange={availability} />);
    expect(screen.queryByTestId("game-story-card")).toBeNull();
    expect(availability).toHaveBeenLastCalledWith(false);
  });

  it("does not create a timestamp for whole-game estimates", () => {
    render(<GameStoryCard input={{ gameId: "leak-only", result: "Win", leaks: [{ name: "Supply blocks", penalty: 5 }] }} onSeek={vi.fn()} />);
    expect(screen.getByText(/Whole-game estimate/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Watch leak/ })).toBeNull();
  });

  it("keeps irregular 0/900-second telemetry unknown across the elapsed-time gap", () => {
    const rows = (times: number[], army: number) => times.map(time => ({ time, army_value: army, food_workers: 20, minerals_collection_rate: 500, vespene_collection_rate: 100 }));
    const { rerender } = render(<GameStoryCard input={{ gameId: "gaps", result: "Win", statsEvents: rows([0, 900], 1000), oppStatsEvents: rows([0, 900], 500) }} onSeek={vi.fn()} />);
    const strip = screen.getByTestId("game-story-lead-strip");
    expect(strip.querySelectorAll('[data-lead-state="known"]')).toHaveLength(0);
    expect(strip.querySelectorAll('[data-lead-state="unknown"]').length).toBeGreaterThan(1);
    expect(Number(strip.lastElementChild?.getAttribute("data-end"))).toBe(900);
    rerender(<GameStoryCard input={{ gameId: "gaps", result: "Win", statsEvents: rows([0, 10, 900], 1000), oppStatsEvents: rows([0, 10, 900], 500) }} onSeek={vi.fn()} />);
    const known = [...strip.querySelectorAll('[data-lead-state="known"]')];
    expect(known).toHaveLength(1);
    expect(Number(known[0].getAttribute("data-start"))).toBe(0);
    expect(Number(known[0].getAttribute("data-end"))).toBe(10);
    expect(Number(strip.lastElementChild?.getAttribute("data-end"))).toBe(900);
  });

  it("renders estimated combined resources without claiming mineral/gas/unit detail or a missing side's zero", () => {
    const fight: StoryFight = { id: "estimated", start: 60, end: 80, duration: 20, estimated: true,
      me: { minerals: 0, gas: 0, supply: null, unpriced: 0, units: [], estimatedValue: 1000 },
      opp: { minerals: 0, gas: 0, supply: null, unpriced: 0, units: [] },
      tradeRatio: null, outcome: "unknown", label: "Estimated fight · one side unmeasured" };
    render(<FightLedger fights={[fight]} onSeek={vi.fn()} />);
    const cards = within(screen.getByTestId("fight-ledger-cards"));
    expect(cards.getByText("1,000 estimated resources")).toBeTruthy();
    expect(cards.getByText("Resource loss unmeasured")).toBeTruthy();
    expect(cards.queryByText(/0 minerals/)).toBeNull();
    expect(cards.queryByText("0 estimated resources")).toBeNull();
  });
});

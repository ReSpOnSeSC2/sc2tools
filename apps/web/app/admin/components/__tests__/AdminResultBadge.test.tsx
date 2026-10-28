import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminGameDetail, type AdminGameDetailGame } from "../AdminGameDetail";
import { ResultBadge } from "../ResultBadge";

vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined, error: null, isLoading: false, mutate: vi.fn() }) }));
vi.mock("@/components/analyzer/charts/BuildOrderTimeline", () => ({ BuildOrderTimeline: () => null }));
vi.mock("@/components/analyzer/charts/ResourcesOverTimeChart", () => ({ ResourcesOverTimeChart: () => null }));
vi.mock("@/components/analyzer/charts/ChronoAllocationChart", () => ({ ChronoAllocationChart: () => null }));
vi.mock("@/components/analyzer/macro/ActiveArmyChart", () => ({ ActiveArmyChart: () => null }));
afterEach(cleanup);

it.each([
  ["Victory", "Win"], ["win", "Win"], [" WIN ", "Win"],
  ["Defeat", "Loss"], ["loss", "Loss"], [" LOSS ", "Loss"],
  ["Tie", "Tie"], ["tie", "Tie"], ["draw", "Tie"],
] as const)("uses the canonical recorded result for %s", (result, label) => {
  const { container } = render(<ResultBadge result={result} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(container.firstElementChild?.firstElementChild?.classList.contains(label === "Win" ? "text-success" : label === "Loss" ? "text-danger" : "text-text-muted")).toBe(true);
  if (label !== "Loss") expect(container.firstElementChild?.firstElementChild?.classList.contains("text-danger")).toBe(false);
});

it.each([null, undefined, "", "Undecided", "unrecognized"])("shows an accessible unrecorded result for %s", (result) => {
  const { container } = render(<ResultBadge result={result} />);
  expect(screen.getByText("—").getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByText("Result not recorded").classList.contains("sr-only")).toBe(true);
  expect(screen.queryByText("Loss")).toBeNull();
  expect(container.firstElementChild?.firstElementChild?.classList.contains("text-text-muted")).toBe(true);
});

const game: AdminGameDetailGame = {
  gameId: "fixture-game", date: "2026-10-28T12:00:00Z", result: "Tie",
  myRace: "Protoss", map: "Alcyone", durationSec: 600, myMmr: 4500, macroScore: 70,
  opponent: { displayName: "Rival", race: "Zerg", mmr: 4500 },
};
it.each(["Tie", "Undecided", null])("the actual detail view does not show %s as a loss", (result) => {
  render(<AdminGameDetail userId="owner" game={{ ...game, result }} onBack={vi.fn()} />);
  expect(screen.getByText(result === "Tie" ? "Tie" : "Result not recorded")).toBeTruthy();
  expect(screen.queryByText("Loss")).toBeNull();
});

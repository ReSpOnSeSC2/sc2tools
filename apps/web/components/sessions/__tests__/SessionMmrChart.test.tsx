import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionMmrChart, sessionMmrCurve } from "../SessionMmrChart";
import { mmrTrack } from "./sessionCardFixtures";
import type { SessionDetailTrack, SessionMmrStep } from "@/lib/sessionHistory";

vi.mock("@/lib/charts/theme", () => ({ useChartKit: () => ({ axis: "currentColor", grid: "currentColor", series: ["currentColor"], tokens: { text: "currentColor" } }) }));
afterEach(cleanup);
function step(position: number, value: number | null): SessionMmrStep {
  return { position, value, date: "2026-10-27T03:40:00.000Z", gameId: null, source: value === null ? null : "replay" };
}

it("uses one observed first point, distinct tied-time game positions and separate segments around missing values", () => {
  const curve = sessionMmrCurve([step(1, null), step(2, 3000), step(3, 3020), step(4, null), step(5, 3010)]);
  expect(curve.first).toBe(1); expect(curve.last).toBe(5);
  expect(curve.x(2)).toBeLessThan(curve.x(3));
  expect(curve.path.match(/ M/g)).toHaveLength(2);
  expect(curve.path.startsWith(` M${curve.x(2)} ${curve.y(3000)}`)).toBe(true);
  expect(curve.path).not.toContain(`M${curve.x(1)} `);
  expect(curve.path).toContain(`M${curve.x(5)} ${curve.y(3010)}`);
});

it("plots all bounded observations with one path while paging only the accessible table and keeping inspection local", () => {
  const track: SessionDetailTrack = { ...mmrTrack({ games: 125, samples: 125, legacySamples: 0, start: 3000, end: 3124, delta: 124, peak: 3124 }), steps: Array.from({ length: 125 }, (_, index) => step(index + 1, 3000 + index)) };
  render(<SessionMmrChart tracks={[track]} timeZone="UTC" />);
  const curve = screen.getByTestId("recorded-mmr-curve"); const before = curve.getAttribute("d");
  expect(before).toContain(`H764`);
  expect(screen.getAllByRole("row", { hidden: true })).toHaveLength(51);
  fireEvent.click(screen.getByText("Recorded point table"));
  fireEvent.click(screen.getByRole("button", { name: "Next 50 observations" }));
  expect(screen.getAllByRole("row")).toHaveLength(51);
  expect(screen.getByText(/Showing 51–100 of 125/)).toBeTruthy();
  expect(curve.getAttribute("d")).toBe(before);
  fireEvent.change(screen.getByRole("slider", { name: "Inspect a recorded observation" }), { target: { value: "124" } });
  expect(screen.getByRole("status").textContent).toContain("Game 125");
  expect(screen.queryAllByRole("link")).toHaveLength(0);
});

it.each([
  { ratingScope: "ranked-1v1", ladderRace: null },
  { ratingScope: "ranked-team", ladderRace: "P" },
  { ratingScope: "custom-1v1", ladderRace: "P" },
] as const)("keeps $ratingScope/$ladderRace raw observations disconnected when the rating track is not fully identified", values => {
  const track: SessionDetailTrack = { ...mmrTrack({ ...values, comparable: false, delta: null, games: 3, missingGames: 1, legacySamples: 0 }), steps: [step(1, 3000), step(2, null), step(3, 3020)] };
  render(<SessionMmrChart tracks={[track]} timeZone="UTC" />);
  expect(screen.queryByTestId("recorded-mmr-curve")).toBeNull();
  expect(screen.getByText(/Rating track not fully identified/)).toBeTruthy();
  expect(screen.getAllByRole("row")).toHaveLength(4);
  expect(screen.getByText("3,000")).toBeTruthy(); expect(screen.getByText("3,020")).toBeTruthy();
});

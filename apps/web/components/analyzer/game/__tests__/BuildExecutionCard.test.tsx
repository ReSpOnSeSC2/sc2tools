import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { executionFixture } from "./buildExecutionFixtures";
import { BuildExecutionCard } from "../BuildExecutionCard";
const harness = vi.hoisted(() => ({ practice: {} as Record<string, unknown> }));
vi.mock("@/components/practice/PracticeButton", () => ({ PracticeButton: (props: Record<string, unknown>) => { harness.practice = props; return <button>Practice in PvZ</button>; } }));
afterEach(cleanup);
const events = [{ name: "Nexus", time: 140, category: "building" }];
it("shows descriptive rule counts, distinct deadline/event chips and shared-clock seeking", () => {
  const seek = vi.fn(); render(<BuildExecutionCard data={executionFixture()} gameId="g" events={events} onSeek={seek} />);
  expect(screen.getByRole("heading", { name: "Private Stargate — 1/2 rules" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "1 observed passes, 1 unmet rules and 0 unknown rules" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "At 4:50" })); fireEvent.click(screen.getByRole("button", { name: "Deadline 6:00" }));
  fireEvent.click(screen.getByRole("button", { name: /Natural · Nexus/ }));
  expect(seek.mock.calls.map(call => call[0])).toEqual([290, 360, 140]);
  expect(screen.getByText("20s later")).toBeTruthy(); expect(screen.getByText("5s earlier")).toBeTruthy();
  expect(screen.getByText(/latest 25 eligible games.*20 recorded timing logs/)).toBeTruthy();
  expect(harness.practice).toMatchObject({ privateBuild: true, build: { slug: "stargate", sourceGameId: "g" } });
  expect(harness.practice.target).toBeTruthy();
});
it("unknown rows and percentages stay unknown while known rows remain visible", () => {
  const data = executionFixture(); data.rules[1] = { ...data.rules[1], unavailable: true, got: null, evidenceSec: null, evidenceKind: null, sentence: "Nexus: evidence unavailable" }; data.knownCount = 1; data.matchPct = null;
  render(<BuildExecutionCard data={data} gameId="g" events={events} />);
  expect(screen.getByText("1 rule unknown. Overall percentage withheld.")).toBeTruthy();
  expect(screen.queryByText("50%")).toBeNull(); expect(screen.queryByRole("button", { name: /Deadline/ })).toBeNull();
  expect(within(screen.getByRole("list", { name: "Build rule evidence" })).getByText("Unknown")).toBeTruthy();
});
it("catalog and zero-rule custom builds never invent a grade", () => {
  const data = executionFixture(); data.rules = []; data.ruleCount = data.knownCount = data.passedCount = 0; data.matchPct = null; data.build!.source = "catalog";
  const view = render(<BuildExecutionCard data={data} gameId="g" />);
  expect(screen.getByText(/Catalog builds show timings only/)).toBeTruthy(); expect(screen.queryByRole("list", { name: "Build rule evidence" })).toBeNull();
  data.build!.source = "custom"; view.rerender(<BuildExecutionCard data={data} gameId="g" />);
  expect(screen.getByText(/This build has no rules yet/)).toBeTruthy(); expect(screen.queryByText("0%")).toBeNull();
});
it("two samples hide the comparison, three show it, and sparse states explain the exact floor", () => {
  const data = executionFixture(); data.timings = data.timings.filter(row => row.kind === "first_tech");
  const view = render(<BuildExecutionCard data={data} gameId="g" />);
  expect(screen.getByText("Timings appear after 3 games with the same recorded milestone.")).toBeTruthy();
  expect(screen.getByText("Comparison unavailable at this sample size.")).toBeTruthy();
  data.timings[0] = { ...data.timings[0], n: 3, medianSec: 95, p25Sec: 90, p75Sec: 100, deltaSec: 5 };
  view.rerender(<BuildExecutionCard data={data} gameId="g" />); expect(screen.getByText("5s later")).toBeTruthy();
});
it("has honest no-build, missing-log, unavailable-definition, retry and loading states", () => {
  const data = executionFixture(), retry = vi.fn();
  const view = render(<BuildExecutionCard gameId="g" />); expect(screen.getByText("Check in a build to grade this game.")).toBeTruthy();
  view.rerender(<BuildExecutionCard gameId="g" unavailable />); expect(screen.getByText(/Rules are unknown until an own build log/)).toBeTruthy();
  data.build!.deleted = true; view.rerender(<BuildExecutionCard data={data} gameId="g" />); expect(screen.getByText(/definition is no longer available/)).toBeTruthy();
  view.rerender(<BuildExecutionCard gameId="g" loading />); expect(screen.getByRole("status")).toBeTruthy();
  view.rerender(<BuildExecutionCard gameId="g" error={{ status: 503 }} onRetry={retry} />); fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(retry).toHaveBeenCalledOnce();
});

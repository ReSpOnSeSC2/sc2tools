import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DossierAnalysis } from "@/lib/dossierTypes";
const harness = vi.hoisted(() => ({ data: undefined as DossierAnalysis | undefined, warmNull: false, error: null as unknown, previous: false, paths: [] as Array<string | null>, props: {} as Record<string, unknown> }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => { harness.paths.push(path); return { data: path || harness.warmNull ? harness.data : undefined, error: harness.error, isPreviousData: harness.previous }; } }));
vi.mock("./BuildOrderColumns", () => ({ BuildOrderColumns: (props: Record<string, unknown>) => { harness.props = props; return <output>{props.myTimingBaseline ? "Compared" : "No comparison"}</output>; } }));
import { GameBuildOrderColumns } from "./GameBuildOrderColumns";
afterEach(() => { cleanup(); harness.paths = []; harness.data = undefined; harness.warmNull = false; harness.error = null; harness.previous = false; });
it("shares one dossier resource while preserving every existing workspace and action prop", () => {
  harness.data = { medianTimings: {} }; const events = [{ time: 300, name: "Stargate" }]; const seek = vi.fn();
  render(<GameBuildOrderColumns timingContext={{ path: "/v1/builds/Test#3", matchup: "PvZ" }} myEvents={events} onSeek={seek} myAction={<button>Practice</button>} workspace={{ myMeta: { title: "Me", sourceUrl: "/g" }, oppMeta: { title: "Them", sourceUrl: "/g" } }} />);
  expect(harness.paths).toEqual(["/v1/builds/Test#3"]);
  expect(harness.props.myEvents).toBe(events); expect(harness.props.onSeek).toBe(seek);
  expect(harness.props.workspace).toMatchObject({ myMeta: { title: "Me" }, oppMeta: { title: "Them" } });
  expect(harness.props.myAction).toBeTruthy(); expect(screen.getByText("Compared")).toBeTruthy();
});
it("withholds a previous cohort or failed cached lookup, and removes comparison when identity disappears", () => {
  harness.data = { medianTimings: {} };
  const events = [{ time: 300, name: "Stargate" }];
  const view = render(<GameBuildOrderColumns myEvents={events} timingContext={{ path: "/v1/builds/A#0", matchup: "PvZ" }} />);
  expect(screen.getByText("Compared")).toBeTruthy();
  harness.previous = true; view.rerender(<GameBuildOrderColumns myEvents={events} timingContext={{ path: "/v1/builds/B#0", matchup: "PvT" }} />);
  expect(screen.getByText("No comparison")).toBeTruthy();
  harness.previous = false; harness.error = { status: 404 };
  view.rerender(<GameBuildOrderColumns myEvents={events} timingContext={{ path: "/v1/builds/B#0", matchup: "PvT" }} />);
  expect(screen.getByText("No comparison")).toBeTruthy();
  harness.error = null; view.rerender(<GameBuildOrderColumns myEvents={events} />);
  expect(harness.paths.at(-1)).toBeNull(); expect(screen.getByText("No comparison")).toBeTruthy();
});
it.each(["missing", "loading", "error", "not_extracted", "empty"])("does not request or pass a warm baseline for %s own build orders", mode => {
  harness.data = { medianTimings: {} }; harness.warmNull = true;
  render(<GameBuildOrderColumns timingContext={{ path: "/v1/builds/A#0", matchup: "PvZ" }}
    myEvents={mode === "missing" ? [] : [{ time: 300, name: "Stargate" }]} loading={mode === "loading"}
    error={mode === "error" ? { status: 500 } : undefined} myStatus={mode === "not_extracted" ? "not_extracted" : mode === "empty" ? "empty" : "ok"} />);
  expect(harness.paths).toEqual([null]); expect(screen.getByText("No comparison")).toBeTruthy();
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DossierAnalysis } from "@/lib/dossierTypes";
const harness = vi.hoisted(() => ({ data: undefined as DossierAnalysis | undefined, error: null as unknown, previous: false, paths: [] as Array<string | null>, props: {} as Record<string, unknown> }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => { harness.paths.push(path); return { data: path ? harness.data : undefined, error: harness.error, isPreviousData: harness.previous }; } }));
vi.mock("./BuildOrderColumns", () => ({ BuildOrderColumns: (props: Record<string, unknown>) => { harness.props = props; return <output>{props.myTimingBaseline ? "Compared" : "No comparison"}</output>; } }));
import { GameBuildOrderColumns } from "./GameBuildOrderColumns";
afterEach(() => { cleanup(); harness.paths = []; harness.data = undefined; harness.error = null; harness.previous = false; });
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
  const view = render(<GameBuildOrderColumns timingContext={{ path: "/v1/builds/A#0", matchup: "PvZ" }} />);
  harness.previous = true; view.rerender(<GameBuildOrderColumns timingContext={{ path: "/v1/builds/B#0", matchup: "PvT" }} />);
  expect(screen.getByText("No comparison")).toBeTruthy();
  harness.previous = false; harness.error = { status: 404 };
  view.rerender(<GameBuildOrderColumns timingContext={{ path: "/v1/builds/B#0", matchup: "PvT" }} />);
  expect(screen.getByText("No comparison")).toBeTruthy();
  harness.error = null; view.rerender(<GameBuildOrderColumns />);
  expect(harness.paths.at(-1)).toBeNull(); expect(screen.getByText("No comparison")).toBeTruthy();
});

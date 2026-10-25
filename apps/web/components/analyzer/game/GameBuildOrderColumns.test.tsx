import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { executionFixture } from "./__tests__/buildExecutionFixtures";
const harness = vi.hoisted(() => ({ request: vi.fn(), props: {} as Record<string, unknown>, card: {} as Record<string, unknown> }));
vi.mock("@/lib/clientApi", () => ({ useApi: harness.request }));
vi.mock("./BuildOrderColumns", () => ({ BuildOrderColumns: (props: Record<string, unknown>) => { harness.props = props; return <output>{props.myExecutionTimings ? "Compared" : "No comparison"}</output>; } }));
vi.mock("./BuildExecutionCard", () => ({ BuildExecutionCard: (props: Record<string, unknown>) => { harness.card = props; return null; } }));
import { GameBuildOrderColumns } from "./GameBuildOrderColumns";
afterEach(() => { cleanup(); harness.request.mockClear(); });
it("uses the parent's single execution response and preserves every workspace/action prop without a dossier GET", () => {
  const data = executionFixture(), events = [{ time: 300, name: "Stargate" }], seek = vi.fn();
  render(<GameBuildOrderColumns gameId="g" execution={data} myEvents={events} onSeek={seek} myAction={<button>Practice</button>} workspace={{ myMeta: { title: "Me", sourceUrl: "/g" }, oppMeta: { title: "Them", sourceUrl: "/g" } }} />);
  expect(harness.request).not.toHaveBeenCalled(); expect(harness.card.data).toBe(data);
  expect(harness.props.myEvents).toBe(events); expect(harness.props.onSeek).toBe(seek);
  expect(harness.props.workspace).toMatchObject({ myMeta: { title: "Me" }, oppMeta: { title: "Them" } });
  expect(harness.props.myAction).toBeTruthy(); expect(screen.getByText("Compared")).toBeTruthy();
});
it.each(["missing", "loading", "error", "not_extracted", "empty", "execution_error", "execution_loading"])("withholds warm execution evidence for %s own build orders", mode => {
  render(<GameBuildOrderColumns gameId="g" execution={executionFixture()} myEvents={mode === "missing" ? [] : [{ time: 300, name: "Stargate" }]}
    loading={mode === "loading"} error={mode === "error" ? { status: 500 } : undefined}
    executionError={mode === "execution_error" ? { status: 503 } : undefined} executionLoading={mode === "execution_loading"}
    myStatus={mode === "not_extracted" ? "not_extracted" : mode === "empty" ? "empty" : "ok"} />);
  expect(harness.request).not.toHaveBeenCalled(); expect(harness.card.data).toBeUndefined(); expect(screen.getByText("No comparison")).toBeTruthy();
});

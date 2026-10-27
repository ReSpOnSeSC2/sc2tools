import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_ANALYZER_FILTERS, FiltersContext } from "@/lib/filterContext";
import { currentHistory } from "@/components/sessions/__tests__/sessionHistoryFixtures";
import { DashboardKpiStrip } from "../DashboardKpiStrip";

const harness = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const loaded = new Promise<void>(resolve => { release = resolve; });
  return { loaded, release, paths: [] as string[] };
});

// Delay only module resolution. Next's actual dynamic loader and the real
// CurrentSessionCard renderer run; request hooks have a deterministic response.
vi.mock("@/components/sessions/CurrentSessionCard", async original => {
  await harness.loaded;
  return original<typeof import("@/components/sessions/CurrentSessionCard")>();
});
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined, error: undefined, mutate: () => undefined }) }));
vi.mock("@/components/sessions/useSessionRequest", () => ({
  useSessionRequest: (path: string) => {
    harness.paths.push(path);
    return { data: currentHistory(), error: undefined, mutate: () => undefined, current: () => true, key: path };
  },
}));

function tree(dbRev: number) {
  return <FiltersContext.Provider value={{ filters: { ...DEFAULT_ANALYZER_FILTERS, race: "Z" }, setFilters: () => undefined, dbRev, bumpRev: () => undefined, seasons: [] }}><DashboardKpiStrip /></FiltersContext.Provider>;
}
afterEach(() => { harness.release(); cleanup(); localStorage.clear(); });

it("keeps the session slot usable while loading and reads the latest revision on actual mount", async () => {
  const view = render(tree(0));
  const waiting = screen.getByTestId("kpi-today-session");
  expect(within(waiting).getByRole("status").textContent).toBe("Loading session view…");
  expect(waiting.textContent).not.toContain("0 games");
  expect(waiting.textContent).not.toContain("No session in the current view");
  expect(screen.getByText("Active streak")).toBeTruthy();
  expect(harness.paths).toEqual([]);
  view.rerender(tree(9));
  expect(screen.getByTestId("kpi-today-session")).toBeTruthy();
  expect(harness.paths).toEqual([]);
  await act(async () => { harness.release(); });
  await screen.findByText("This session");
  const admitted = screen.getByTestId("kpi-today-session");
  expect(admitted.textContent).toContain("3 games");
  expect(within(admitted).getByRole("link", { name: "View this session" })).toBeTruthy();
  expect(harness.paths.length).toBeGreaterThan(0);
  expect(harness.paths.every(path => path.startsWith("/v1/sessions/current?") && path.endsWith("#9"))).toBe(true);
  expect(harness.paths.some(path => path.includes("race="))).toBe(false);
  expect(screen.queryByText("Loading session view…")).toBeNull();
});

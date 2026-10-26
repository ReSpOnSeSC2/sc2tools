import { useState } from "react";
import { Blob as NodeBlob } from "node:buffer";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FiltersContext, type AnalyzerFilters } from "@/lib/filterContext";

type Row = { name: string; total: number; wins: number; losses: number; winRate: number; planHeldRate?: number | null; ratedGames?: number; winsAboveExpected?: number | null; myMatchups?: Record<string, number> };
const harness = vi.hoisted(() => ({ rows: [] as Row[], paths: [] as string[], filters: [] as AnalyzerFilters[] }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: vi.fn() }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn(), useApi: (path: string) => {
  harness.paths.push(path); return { data: harness.rows, isLoading: false, error: null, mutate: vi.fn() };
} }));
vi.mock("../BuildEditorModal", () => ({ BuildEditorModal: ({ buildName, onClose }: { buildName: string; onClose: () => void }) => <div role="dialog" aria-label={buildName}><button onClick={onClose}>Close build</button></div> }));
vi.mock("../mmr/BuildMmrPanel", () => ({ BuildMmrPanel: () => null }));
vi.mock("../mmr/BuildAgingCurve", () => ({ BuildAgingCurve: () => null }));
vi.mock("../mmr/MmrProgressionByBuild", () => ({ MmrProgressionByBuild: () => null }));
vi.mock("../charts/MixOverTimeChart", () => ({ MixOverTimeChart: () => null }));
import { BuildsTab } from "../BuildsTab";

function Tab({ initial = {} }: { initial?: AnalyzerFilters }) {
  const [filters, set] = useState(initial);
  return <FiltersContext.Provider value={{ filters, dbRev: 0, bumpRev: vi.fn(), seasons: [], setFilters: next => { harness.filters.push(next); set(next); } }}><BuildsTab /></FiltersContext.Provider>;
}
beforeEach(() => {
  localStorage.clear(); harness.paths = []; harness.filters = [];
  harness.rows = [{ name: "Gateway opener", total: 5, wins: 3, losses: 2, winRate: .6, myMatchups: { P: 2, T: 3, Z: 0 } }];
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("shows and sorts measured Held rates while omitting an all-small-sample column", () => {
  harness.rows = [{ ...harness.rows[0], name: "Measured zero", planHeldRate: 0 }, { ...harness.rows[0], name: "Held most", planHeldRate: .8 }, { ...harness.rows[0], name: "Small sample", planHeldRate: null }];
  const view = render(<Tab />); const table = within(screen.getByRole("table"));
  expect(table.getByRole("columnheader", { name: "Plan held" })).toBeTruthy();
  expect(within(table.getByRole("row", { name: /Measured zero/ })).getByText("0.0%")).toBeTruthy();
  expect(within(table.getByRole("row", { name: /Small sample/ })).getByRole("cell", { name: "—" })).toBeTruthy();
  fireEvent.click(table.getByRole("button", { name: "Plan held" }));
  const names = () => table.getAllByRole("row").slice(1).map(row => within(row).getAllByRole("button")[0].textContent);
  expect(names()).toEqual(["Held most", "Measured zero", "Small sample"]);
  fireEvent.click(table.getByRole("button", { name: "Plan held" }));
  expect(names()).toEqual(["Measured zero", "Held most", "Small sample"]);
  expect(screen.getByText("Held 0%")).toBeTruthy();
  cleanup(); localStorage.clear(); harness.rows = [{ ...harness.rows[0], planHeldRate: null }]; render(<Tab />);
  expect(screen.queryByRole("columnheader", { name: "Plan held" })).toBeNull();
  view.unmount();
});

it("exports the displayed Held column as raw fractions and removes it for an all-unknown visible cohort", async () => {
  vi.useFakeTimers();
  harness.rows = [{ ...harness.rows[0], name: "Measured", planHeldRate: .8 }, { ...harness.rows[0], name: "Small", planHeldRate: null }];
  let blob: Blob | null = null; vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", class extends URL { static createObjectURL(value: Blob) { blob = value; return "blob:fixture-held"; } static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<Tab />); fireEvent.click(screen.getByRole("button", { name: "Export these rows as CSV" }));
  const csv = Buffer.from(await blob!.arrayBuffer()).toString("utf8");
  expect(csv).toContain("Build,W,L,Games,WR,Plan held,Vs expected,W/L split"); expect(csv).toContain("Measured,3,2,5,0.6,0.8,,3W 2L"); expect(csv).toContain("Small,3,2,5,0.6,,,3W 2L");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search builds" }), { target: { value: "Small" } });
  fireEvent.click(screen.getByRole("button", { name: "Export these rows as CSV" }));
  expect(Buffer.from(await blob!.arrayBuffer()).toString("utf8")).not.toContain("Plan held");
  vi.runOnlyPendingTimers();
});

it("exposes a focusable named build button and retains row-click convenience without bubbling activation", () => {
  const outer = vi.fn(); render(<div onClick={outer}><Tab /></div>);
  const table = within(screen.getByRole("table")), row = table.getByRole("row", { name: /Gateway opener/ });
  const name = within(row).getByRole("button", { name: "Gateway opener" }) as HTMLButtonElement;
  expect(name.type).toBe("button"); expect(name.tabIndex).toBe(0);
  expect(row.hasAttribute("role")).toBe(false); expect(row.hasAttribute("tabindex")).toBe(false);
  name.focus(); expect(document.activeElement).toBe(name);
  fireEvent.click(name);
  expect(screen.getByRole("dialog", { name: "Gateway opener" })).toBeTruthy(); expect(outer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close build" })); outer.mockClear();
  fireEvent.click(row); expect(screen.getByRole("dialog", { name: "Gateway opener" })).toBeTruthy();
  expect(table.getByRole("columnheader", { name: "W/L split" })).toBeTruthy();
  expect(screen.getByRole("searchbox", { name: "Search builds" })).toBeTruthy();
});

it("sorts nonzero matchup chips and applies the global setter without opening a build", () => {
  render(<Tab initial={{ race: "P", opp_strategy: "Old strategy", regions: "EU", accounts: "1-S2-1-123", map: "Site Delta" }} />);
  const row = within(screen.getByRole("table")).getByRole("row", { name: /Gateway opener/ });
  const chips = within(row).getAllByRole("button").slice(1);
  expect(chips.map(chip => chip.textContent)).toEqual(["vT 3", "vP 2"]);
  fireEvent.click(chips[0]);
  expect(harness.filters.at(-1)).toMatchObject({ race: "P", opp_race: "T", regions: "EU", accounts: "1-S2-1-123", map: "Site Delta" });
  expect(harness.filters.at(-1)?.opp_strategy).toBeUndefined();
  expect(new URL(harness.paths.at(-1)!, "https://fixture.test").searchParams.get("opp_race")).toBe("T");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(row).getByRole("button", { name: "Filter builds vs Terran: 3 games" }).getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector("button button")).toBeNull();
});

it("omits missing, zero and invalid matchup counts", () => {
  harness.rows = [{ ...harness.rows[0], myMatchups: { P: 0, T: -2, Z: NaN } }, { ...harness.rows[0], name: "No metadata", myMatchups: undefined }];
  render(<Tab />); expect(screen.queryByLabelText("Build matchups")).toBeNull();
});

it("downloads only searched, minimum-filtered, sorted rows with raw strength and local export metadata", async () => {
  vi.useFakeTimers(); const exportedAt = new Date(2026, 0, 2, 0, 5); vi.setSystemTime(exportedAt);
  harness.rows = [
    { name: '=Custom "A", opener', total: 5, wins: 3, losses: 2, winRate: .6, ratedGames: 4, winsAboveExpected: -.5 },
    { name: "Custom biggest", total: 9, wins: 6, losses: 3, winRate: 2 / 3, ratedGames: 9, winsAboveExpected: .25 },
    { name: "Custom rare", total: 1, wins: 1, losses: 0, winRate: 1 },
    { name: "Standard", total: 10, wins: 8, losses: 2, winRate: .8 },
  ];
  let blob: Blob | null = null, filename = "";
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("URL", class extends URL { static createObjectURL(value: Blob) { blob = value; return "blob:fixture-builds"; } static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
  render(<Tab initial={{ race: "P", regions: "EU" }} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search builds" }), { target: { value: "Custom" } });
  fireEvent.click(screen.getByRole("radio", { name: "3" }));
  fireEvent.click(screen.getByRole("button", { name: "Export these rows as CSV" }));
  const csv = Buffer.from(await blob!.arrayBuffer()).toString("utf8");
  expect(filename).toBe("sc2tools-builds-2026-01-02.csv");
  expect(csv.startsWith("\uFEFFScope,")).toBe(true);
  expect(csv).toContain(`exported ${exportedAt.toLocaleString()}`);
  expect(csv).toContain("Protoss"); expect(csv).toContain("search Custom · min games 3 · sort total desc");
  expect(csv).toContain("\r\n\r\nBuild,W,L,Games,WR,Vs expected,W/L split\r\n");
  expect(csv).toContain('"\'=Custom ""A"", opener",3,2,5,0.6,-0.5,3W 2L');
  expect(csv.indexOf("Custom biggest")).toBeLessThan(csv.indexOf("'=Custom"));
  expect(csv).not.toContain("Custom rare"); expect(csv).not.toContain("Standard");
  expect(csv.split("\r\n")).toHaveLength(6);
});

it("disables export when no rows remain", () => {
  harness.rows = []; render(<Tab />);
  expect((screen.getByRole("button", { name: "Nothing to export" }) as HTMLButtonElement).disabled).toBe(true);
});

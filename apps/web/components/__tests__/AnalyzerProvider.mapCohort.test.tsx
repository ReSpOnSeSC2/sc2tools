import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnalyzerProvider } from "../AnalyzerProvider";
import { filtersToQuery, useFilters } from "@/lib/filterContext";
vi.mock("@/lib/useSeasons", async (original) => ({ ...(await original<typeof import("@/lib/useSeasons")>()), useSeasons: () => ({ data: undefined }) }));
vi.mock("@/lib/useUserSocket", () => ({ useUserSocket: () => undefined }));
vi.mock("@/components/analyzer/arcade/hooks/useAnalysisGames", () => ({ AnalysisGamesProvider: ({ children }: { children: React.ReactNode }) => children }));
function Controls() {
  const { filters, setFilters } = useFilters();
  return <><output>{filtersToQuery(filters)}</output><button onClick={() => setFilters({ ...filters, map: "Alpha LE", map_exact: '["Alpha LE","Alpha"]', map_exact_label: "Alpha LE" })}>Map cohort</button>
    <button onClick={() => setFilters({ ...filters, map: "Beta" })}>Different map</button><button onClick={() => setFilters({ ...filters, map: "Alpha LE" })}>Original map name</button></>;
}
afterEach(() => { cleanup(); localStorage.clear(); });
describe("analyzer map cohort state", () => {
  it("drops an exact cohort when a caller changes the map and cannot reactivate it by returning to its old name", () => {
    render(<AnalyzerProvider><Controls /></AnalyzerProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Map cohort" }));
    expect(new URLSearchParams(screen.getByRole("status").textContent!).get("map_exact")).toBe('["Alpha LE","Alpha"]');
    expect(localStorage.getItem("analyzer.filters")).not.toContain("map_exact");
    fireEvent.click(screen.getByRole("button", { name: "Different map" }));
    expect(new URLSearchParams(screen.getByRole("status").textContent!).has("map_exact")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Original map name" }));
    expect(new URLSearchParams(screen.getByRole("status").textContent!).has("map_exact")).toBe(false);
  });
});

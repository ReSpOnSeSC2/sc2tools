import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FiltersContext } from "@/lib/filterContext";
import type { CustomBuild } from "@/components/builds/types";

const harness = vi.hoisted(() => ({
  items: [] as CustomBuild[],
  libraryError: null as Error | null,
  libraryLoaded: true,
  performanceLoading: false,
  performance: [] as Array<{ name: string; total: number; wins: number; losses: number; winRate: number }>,
  mutate: vi.fn(async () => undefined),
  paths: [] as string[],
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: vi.fn() }) }));
vi.mock("@/lib/clientApi", () => ({
  apiCall: vi.fn(),
  useApi: (path: string) => {
    harness.paths.push(path);
    return path === "/v1/custom-builds"
      ? {
          data: harness.libraryLoaded ? { items: harness.items } : undefined,
          error: harness.libraryError,
          isValidating: false,
          mutate: harness.mutate,
        }
      : { data: harness.performance, isLoading: harness.performanceLoading };
  },
}));
vi.mock("../BuildEditorModal", () => ({ BuildEditorModal: () => null }));
vi.mock("../mmr/BuildMmrPanel", () => ({ BuildMmrPanel: () => null }));
vi.mock("../mmr/BuildAgingCurve", () => ({ BuildAgingCurve: () => null }));
vi.mock("../mmr/MmrProgressionByBuild", () => ({ MmrProgressionByBuild: () => null }));

import { BuildsTab } from "../BuildsTab";

beforeEach(() => {
  localStorage.clear();
  harness.items = [
    { slug: "new-opener", name: "New unmatched opener", race: "Protoss", vsRace: "Terran" },
    { slug: "opponent/3 rax", name: "3 Rax", race: "Terran", vsRace: "Protoss", perspective: "opponent" },
  ];
  harness.libraryLoaded = true;
  harness.libraryError = null;
  harness.performanceLoading = false;
  harness.performance = [];
  harness.mutate.mockClear();
  harness.paths = [];
});

afterEach(cleanup);

describe("Builds tab saved library visibility", () => {
  it("shows unmatched and opponent builds even when replay and minimum-game filters exclude every performance row", () => {
    localStorage.setItem("analyzer.builds.minGames", "20");
    harness.performance = [{ name: "A replay label", total: 1, wins: 1, losses: 0, winRate: 1 }];
    render(
      <FiltersContext.Provider value={{
        filters: { since: "2026-09-01", regions: "NA", race: "P", map_pool: "ladder" },
        dbRev: 3,
        bumpRev: () => undefined,
        setFilters: () => undefined,
        seasons: [],
      }}>
        <BuildsTab />
      </FiltersContext.Provider>,
    );

    const saved = within(screen.getByRole("region", { name: "Your custom builds" }));
    expect(saved.getByRole("link", { name: /New unmatched opener/ }).getAttribute("href")).toBe("/builds/new-opener");
    expect(saved.getByRole("link", { name: /3 Rax/ }).getAttribute("href")).toBe("/builds/opponent%2F3%20rax");
    expect(saved.getByText("From opponent")).toBeTruthy();
    expect(saved.getByText("Your build")).toBeTruthy();
    expect(screen.getByText("No builds match")).toBeTruthy();
    expect(harness.paths).toContain("/v1/custom-builds");
    expect(harness.paths.some((path) => path.startsWith("/v1/builds?") && path.includes("regions=NA") && path.endsWith("#3"))).toBe(true);
    expect(saved.getByRole("link", { name: "Manage library" }).getAttribute("href")).toBe("/builds");
  });

  it("keeps saved builds accessible while replay statistics are loading", () => {
    harness.performanceLoading = true;
    render(<BuildsTab />);
    expect(screen.getByRole("link", { name: /New unmatched opener/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /3 Rax/ })).toBeTruthy();
  });

  it("opens each saved build by its own slug when display names collide", () => {
    harness.items = [
      { slug: "own-build", name: "Shared name", race: "Protoss" },
      { slug: "opponent-build", name: "Shared name", race: "Terran", perspective: "opponent" },
    ];
    render(<BuildsTab />);
    expect(screen.getAllByRole("link", { name: /Shared name/ }).map((link) => link.getAttribute("href")))
      .toEqual(["/builds/own-build", "/builds/opponent-build"]);
  });

  it("reports library failure and lets the user retry without claiming no builds are saved", () => {
    harness.libraryLoaded = false;
    harness.libraryError = new Error("Unavailable");
    render(<BuildsTab />);
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load your custom builds.");
    expect(screen.queryByText(/No custom builds saved yet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.mutate).toHaveBeenCalledOnce();
  });

  it("retains the last loaded builds when a refresh fails", () => {
    harness.libraryError = new Error("Unavailable");
    render(<BuildsTab />);
    expect(screen.getByRole("alert").textContent).toContain("Showing the last loaded library.");
    expect(screen.getByRole("link", { name: /3 Rax/ })).toBeTruthy();
  });
});

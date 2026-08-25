import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  FiltersContext,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { BuildEditorModal } from "../BuildEditorModal";

const apiCallMock = vi.fn().mockResolvedValue({ items: [] });

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("token") }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
}));

vi.mock("@/components/builds/BuildDossier", () => ({
  BuildDossier: ({ apiPath }: { apiPath: string }) => (
    <output data-testid="dossier-api-path">{apiPath}</output>
  ),
}));

vi.mock("@/components/builds/BuildPublishModal", () => ({
  BuildPublishModal: () => null,
}));

afterEach(() => {
  cleanup();
  apiCallMock.mockClear();
});

describe("BuildEditorModal global filter scope", () => {
  it("passes the complete Builds-page game scope and db revision to the dossier query", () => {
    const filters: AnalyzerFilters = {
      preset: "custom",
      since: "2026-07-19T00:00:00.000Z",
      until: "2026-08-25T23:59:59.999Z",
      regions: "EU,KR",
      map_pool: "ladder",
      game_size: "1v1",
      min_minutes: 10,
      max_minutes: 20,
      exclude_too_short: true,
      race: "P",
      opp_race: "T",
      map: "Golden Aura LE",
      mmr_min: 4200,
      mmr_max: 5100,
      build: "PvT - Macro Transition (Unclassified)",
      opp_strategy: "Terran - Proxy Rax",
    };

    render(
      <FiltersContext.Provider
        value={{
          filters,
          setFilters: () => undefined,
          dbRev: 17,
          bumpRev: () => undefined,
          seasons: [],
        }}
      >
        <BuildEditorModal
          buildName="PvT - Macro Transition (Unclassified)"
          onClose={() => undefined}
        />
      </FiltersContext.Provider>,
    );

    const path = screen.getByTestId("dossier-api-path").textContent || "";
    const [requestPath, revision] = path.split("#");
    const url = new URL(requestPath, "https://sc2.test");

    expect(url.pathname).toBe(
      "/v1/builds/PvT%20-%20Macro%20Transition%20(Unclassified)",
    );
    expect(revision).toBe("17");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      since: filters.since,
      until: filters.until,
      regions: "EU,KR",
      map_pool: "ladder",
      game_size: "1v1",
      min_minutes: "10",
      max_minutes: "20",
      exclude_too_short: "true",
      race: "P",
      opp_race: "T",
      map: "Golden Aura LE",
      mmr_min: "4200",
      mmr_max: "5100",
      build: "PvT - Macro Transition (Unclassified)",
      opp_strategy: "Terran - Proxy Rax",
    });
    expect(url.searchParams.has("preset")).toBe(false);
  });
});

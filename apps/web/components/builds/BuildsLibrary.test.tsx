import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "test-token"),
  userId: "test-user",
  mutateBuilds: vi.fn(async () => undefined),
  mutateStats: vi.fn(async () => undefined),
  mutateStatus: vi.fn(async () => undefined),
  listData: undefined as undefined | Record<string, unknown>,
  listError: undefined as Error | undefined,
  listValidating: false,
  listPages: {} as Record<string, Record<string, unknown> | undefined>,
  pageErrors: {} as Record<string, Error | undefined>,
  ruleStatsData: [] as Array<Record<string, unknown>> | undefined,
  ruleStatsError: undefined as Error | undefined,
  statusData: undefined as undefined | Record<string, unknown>,
  paths: [] as string[],
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken, userId: harness.userId }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: (path: string | null) => {
    if (!path) return { mutate: harness.mutateStats };
    harness.paths.push(path);
    const isList = path === "/v1/custom-builds" || path.startsWith("/v1/custom-builds?");
    const pageKey = path.includes("?") ? path.split("?")[1] : "";
    const listData = pageKey in harness.listPages ? harness.listPages[pageKey] : harness.listData;
    const listError = harness.pageErrors[pageKey] ?? harness.listError;
    return isList
      ? {
          data: listData,
          isLoading: listData === undefined && !listError,
          isValidating: harness.listValidating,
          error: listError,
          mutate: harness.mutateBuilds,
        }
      : path.startsWith("/v1/custom-builds/stats?")
        ? {
            data: harness.ruleStatsData,
            isLoading: harness.ruleStatsData === undefined && !harness.ruleStatsError,
            error: harness.ruleStatsError,
            mutate: harness.mutateStats,
          }
        : {
            data: harness.statusData,
            isLoading: false,
            error: null,
            mutate: harness.mutateStatus,
          };
  },
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({
    toast: { success: harness.success, error: harness.error },
  }),
}));

vi.mock("./BuildCard", () => ({
  BuildCard: ({
    build,
    onReclassify,
    onEdit,
    reclassifyDisabled,
  }: {
    build: {
      slug: string;
      name: string;
      stats?: { total: number };
      statsState?: string;
      statsSource?: string;
    };
    onReclassify: (slug: string) => void;
    onEdit: (slug: string) => void;
    reclassifyDisabled?: boolean;
  }) => (
    <>
      <button
        type="button"
        disabled={reclassifyDisabled}
        onClick={() => onReclassify(build.slug)}
      >
        Reclassify {build.name}
      </button>
      <button type="button" onClick={() => onEdit(build.slug)}>
        Edit {build.name}
      </button>
      <span>
        stats:{build.stats?.total ?? "none"}:{build.statsSource ?? "none"}:
        {build.statsState ?? "none"}
      </span>
    </>
  ),
}));

vi.mock("./BuildFilterBar", () => ({
  BuildFilterBar: ({ value, onChange, total }: {
    value: { search: string; sort: string; matchup: string; hideEmpty: boolean };
    onChange: (next: unknown) => void;
    total: number;
  }) => <>
    <input aria-label="Search" value={value.search} onChange={(event) => onChange({ ...value, search: event.target.value })} />
    <select aria-label="Sort" value={value.sort} onChange={(event) => onChange({ ...value, sort: event.target.value })}>
      <option value="updated">Recently edited</option><option value="games">Most games</option>
    </select>
    <span>{total} matching builds</span>
  </>,
}));
vi.mock("./BuildDossierModal", () => ({ BuildDossierModal: () => null }));
vi.mock("./BuildEditorSheet", () => ({ BuildEditorSheet: () => null }));
vi.mock("./EditCustomBuildLauncher", () => ({
  EditCustomBuildLauncher: ({
    build,
    onSaved,
  }: {
    build: { slug: string; name: string } | null;
    onSaved: (
      saved: { slug: string; name: string; race: "Protoss"; vsRace: "Terran" },
      result: {
        reclassifyRequested: boolean;
        reclassifyStatus: "queued";
        reclassifyGeneration: string;
      },
    ) => void;
  }) => build ? (
    <button
      type="button"
      onClick={() => onSaved(
        { ...build, race: "Protoss", vsRace: "Terran" },
        {
          reclassifyRequested: true,
          reclassifyStatus: "queued",
          reclassifyGeneration: "save-generation",
        },
      )}
    >
      Finish editor save
    </button>
  ) : null,
}));
vi.mock("./BuildPublishModal", () => ({ BuildPublishModal: () => null }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));

import { BuildsLibrary } from "./BuildsLibrary";

beforeEach(() => {
  harness.userId = "test-user";
  harness.apiCall.mockReset();
  harness.getToken.mockClear();
  harness.mutateBuilds.mockReset();
  harness.mutateBuilds.mockResolvedValue(undefined);
  harness.mutateStats.mockClear();
  harness.mutateStatus.mockReset();
  harness.mutateStatus.mockResolvedValue(undefined);
  harness.statusData = undefined;
  harness.listData = {
    items: [{
      slug: "pvt-test",
      name: "PvT Test Build",
      race: "Protoss",
      vsRace: "Terran",
    }],
  };
  harness.listError = undefined;
  harness.listValidating = false;
  harness.listPages = {};
  harness.pageErrors = {};
  harness.ruleStatsData = [];
  harness.ruleStatsError = undefined;
  harness.success.mockReset();
  harness.error.mockReset();
  harness.paths.length = 0;
});

afterEach(cleanup);

describe("BuildsLibrary pagination", () => {
  function page(start: number, count: number, nextCursor: string | null) {
    return {
      items: Array.from({ length: count }, (_, index) => ({
        slug: `build-${start + index}`,
        name: `Build ${start + index}`,
        race: "Protoss",
        vsRace: "Terran",
      })),
      total: 104,
      libraryTotal: 104,
      limit: 50,
      nextCursor,
    };
  }

  it("reaches builds beyond 100, replaces page cards, and requests stats only for that page", () => {
    harness.listData = page(1, 50, "second");
    harness.listPages["cursor=second"] = page(51, 50, "third");
    harness.listPages["cursor=third"] = page(101, 4, null);
    render(<BuildsLibrary />);

    expect(screen.getByText("Showing 1–50 of 104 builds")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.queryByRole("button", { name: "Edit Build 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Build 51" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Edit Build 104" })).toBeTruthy();
    expect(screen.getByText("Showing 101–104 of 104 builds")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    const statsPath = harness.paths.filter((path) => path.startsWith("/v1/custom-builds/stats?")).at(-1)!;
    expect(new URLSearchParams(statsPath.split("?")[1]).get("slugs")).toBe("build-101,build-102,build-103,build-104");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByRole("button", { name: "Edit Build 51" })).toBeTruthy();
  });

  it("runs search and sorting over the full library and resets the cursor", () => {
    harness.listData = page(1, 50, "second");
    harness.listPages["cursor=second"] = page(51, 50, "third");
    harness.listPages["search=Build+104"] = { ...page(104, 1, null), total: 1 };
    harness.listPages["search=Build+104&sort=games"] = { ...page(104, 1, null), total: 1 };
    render(<BuildsLibrary />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "Build 104" } });

    expect(screen.getByRole("button", { name: "Edit Build 104" })).toBeTruthy();
    expect(screen.getByText("1 matching builds")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Custom build pages" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "games" } });
    expect(harness.paths).toContain("/v1/custom-builds?search=Build+104&sort=games");
    expect(harness.paths.some((path) => path.includes("search=") && path.includes("cursor="))).toBe(false);
  });

  it("keeps retry and Previous available when a later page fails", () => {
    harness.listData = page(1, 50, "second");
    harness.listPages["cursor=second"] = undefined;
    harness.pageErrors["cursor=second"] = new Error("HTTP 503");
    render(<BuildsLibrary />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load your build library");
    expect(screen.queryByText("No custom builds yet")).toBeNull();
    expect(screen.queryByText("No builds match these filters")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.mutateBuilds).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByRole("button", { name: "Edit Build 1" })).toBeTruthy();
  });

  it("does not carry a page cursor into a different signed-in account", () => {
    harness.listData = page(1, 50, "second");
    harness.listPages["cursor=second"] = page(51, 50, "third");
    const view = render(<BuildsLibrary />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    harness.userId = "another-user";
    harness.listData = { items: [{ slug: "another-build", name: "Another account build", race: "Terran" }], total: 1, limit: 50, nextCursor: null };
    view.rerender(<BuildsLibrary />);
    expect(screen.getByRole("button", { name: "Edit Another account build" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit Build 51" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Custom build pages" })).toBeNull();
  });

  it("returns to the first page and refreshes after a saved build changes its ordering", async () => {
    harness.listData = page(1, 50, "second");
    harness.listPages["cursor=second"] = page(51, 50, "third");
    render(<BuildsLibrary />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Build 51" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish editor save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Build 1" })).toBeTruthy());
    expect(harness.mutateBuilds).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("BuildsLibrary loading failures", () => {
  it("shows a retryable load error instead of claiming the library is empty", async () => {
    harness.listData = undefined;
    harness.listError = new Error("HTTP 503");
    harness.mutateBuilds.mockRejectedValueOnce(new Error("still unavailable"));

    render(<BuildsLibrary />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't load your build library",
    );
    expect(screen.queryByText("No custom builds yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create your first build" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(harness.mutateBuilds).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("keeps cached builds visible when a refresh fails and clears the warning after recovery", () => {
    const view = render(<BuildsLibrary />);

    harness.listError = new Error("HTTP 502");
    view.rerender(<BuildsLibrary />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Showing your previously loaded builds. Retry to check for changes.",
    );
    expect(screen.getByRole("button", { name: "Edit PvT Test Build" })).toBeTruthy();
    expect(screen.queryByText("No custom builds yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(harness.mutateBuilds).toHaveBeenCalledTimes(1);
    harness.listValidating = true;
    view.rerender(<BuildsLibrary />);
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);

    harness.listError = undefined;
    harness.listValidating = false;
    view.rerender(<BuildsLibrary />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit PvT Test Build" })).toBeTruthy();
  });

  it("does not treat a stale empty response as a confirmed empty library", () => {
    harness.listData = { items: [] };
    harness.listError = new Error("HTTP 502");

    render(<BuildsLibrary />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn't load your build library",
    );
    expect(screen.queryByText("No custom builds yet")).toBeNull();
  });

  it("shows the first-build prompt only after an empty library loads successfully", () => {
    harness.listData = undefined;
    const view = render(<BuildsLibrary />);

    expect(screen.queryByText("No custom builds yet")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    harness.listData = { items: [] };
    view.rerender(<BuildsLibrary />);

    expect(screen.getByText("No custom builds yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create your first build" })).toBeTruthy();
  });
});

describe("BuildsLibrary queued reclassification feedback", () => {
  it("keeps creation and matching available for libraries larger than 100 builds", () => {
    harness.listData = {
      items: [{
        slug: "pvt-test",
        name: "PvT Test Build",
        race: "Protoss",
        vsRace: "Terran",
      }],
      total: 104,
      limit: 50,
      nextCursor: "second-page",
    };

    render(<BuildsLibrary />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("104 matching builds")).toBeTruthy();
    expect((screen.getByRole("button", {
      name: "Reclassify replays",
    }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", {
      name: "Reclassify PvT Test Build",
    }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", {
      name: "New build",
    }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("confirms that one build's replay matching was queued", async () => {
    harness.apiCall.mockResolvedValueOnce({
      ok: true,
      slug: "pvt-test",
      name: "PvT Test Build",
      status: "queued",
    });
    render(<BuildsLibrary />);

    fireEvent.click(
      screen.getByRole("button", { name: "Reclassify PvT Test Build" }),
    );

    await waitFor(() => {
      expect(harness.success).toHaveBeenCalledWith(
        expect.stringMatching(/Replay matching queued for .*PvT Test Build/),
        {
          description:
            "Your full replay history will update safely in the background.",
        },
      );
    });
    expect(harness.error).not.toHaveBeenCalled();
  });

  it("confirms that all builds were queued without claiming completion", async () => {
    harness.apiCall.mockResolvedValueOnce({
      ok: true,
      status: "queued",
      builds: 1,
    });
    render(<BuildsLibrary />);

    fireEvent.click(screen.getByRole("button", { name: "Reclassify replays" }));

    await waitFor(() => {
      expect(harness.success).toHaveBeenCalledWith(
        "Replay matching queued for 1 build.",
        {
          description:
            "Your full replay history will update safely in the background.",
        },
      );
    });
    expect(harness.error).not.toHaveBeenCalled();
  });

  it("keeps retrying work visibly active and prevents a duplicate bulk run", () => {
    harness.statusData = {
      status: "retry",
      generation: "generation-1",
      attempts: 1,
      progress: { scanned: 40, tagged: 3, cleared: 1 },
    };
    render(<BuildsLibrary />);

    expect(screen.getByText("Retrying replay matching safely…")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Matching replays…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/3 tag changes found/)).toBeTruthy();
    expect(harness.success).not.toHaveBeenCalledWith(
      "Replay matching complete.",
      expect.anything(),
    );
  });

  it("does not replay a historical completion toast on a fresh mount", () => {
    harness.statusData = {
      status: "complete",
      generation: "old-generation",
      completedAt: "2026-08-12T12:00:00.000Z",
      progress: { scanned: 500, tagged: 12, cleared: 2 },
    };
    render(<BuildsLibrary />);

    expect(harness.success).not.toHaveBeenCalledWith(
      "Replay matching complete.",
      expect.anything(),
    );
    expect(harness.mutateBuilds).not.toHaveBeenCalled();
    expect(harness.mutateStats).not.toHaveBeenCalled();
  });

  it("announces an observed completion and refreshes build statistics", async () => {
    harness.statusData = {
      status: "running",
      generation: "current-generation",
      progress: { scanned: 100, tagged: 4, cleared: 1 },
    };
    const view = render(<BuildsLibrary />);

    harness.statusData = {
      status: "complete",
      generation: "current-generation",
      completedAt: "2026-08-13T12:00:00.000Z",
      progress: { scanned: 125, tagged: 5, cleared: 2 },
    };
    view.rerender(<BuildsLibrary />);

    await waitFor(() => {
      expect(harness.success).toHaveBeenCalledWith(
        "Replay matching complete.",
        expect.objectContaining({
          description: expect.stringContaining("125 replays checked"),
        }),
      );
    });
    expect(harness.mutateBuilds).toHaveBeenCalled();
    expect(harness.mutateStats).toHaveBeenCalled();
  });

  it("never requests or inherits a same-name legacy build count", () => {
    harness.ruleStatsData = undefined;
    harness.ruleStatsError = new Error("HTTP 503");

    render(<BuildsLibrary />);

    expect(screen.getByText("stats:none:none:unavailable")).toBeTruthy();
    expect(harness.paths).not.toContain("/v1/builds");
  });

  it("matches authoritative totals by stable slug, never display name", () => {
    harness.ruleStatsData = [{
      slug: "different-build",
      name: "PvT Test Build",
      total: 99,
      wins: 99,
      losses: 0,
      winRate: 1,
    }];

    render(<BuildsLibrary />);

    expect(screen.getByText("stats:none:classified:ready")).toBeTruthy();
  });

  it("marks replay stats unavailable instead of presenting a false zero", () => {
    harness.ruleStatsData = undefined;
    harness.ruleStatsError = new Error("HTTP 502");

    render(<BuildsLibrary />);

    expect(screen.getByText("stats:none:none:unavailable")).toBeTruthy();
  });

  it("does not present stale authoritative data after its refresh fails", () => {
    harness.ruleStatsData = [{
      slug: "pvt-test",
      name: "PvT Test Build",
      total: 17,
      wins: 10,
      losses: 7,
      winRate: 10 / 17,
    }];
    harness.ruleStatsError = new Error("HTTP 502");

    render(<BuildsLibrary />);

    expect(screen.getByText("stats:none:none:unavailable")).toBeTruthy();
    expect(screen.queryByText(/stats:17:/)).toBeNull();
  });

  it("keeps totals provisional while authoritative slug stats are loading", () => {
    harness.ruleStatsData = undefined;
    harness.ruleStatsError = undefined;

    render(<BuildsLibrary />);

    expect(screen.getByText("stats:none:none:loading")).toBeTruthy();
  });

  it("keeps a confirmed save queue visible when the library refresh fails", async () => {
    harness.mutateBuilds.mockRejectedValueOnce(new Error("refresh failed"));
    render(<BuildsLibrary />);

    fireEvent.click(screen.getByRole("button", { name: "Edit PvT Test Build" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish editor save" }));

    await waitFor(() => {
      expect(harness.mutateStatus).toHaveBeenCalledWith(
        { status: "queued", generation: "save-generation" },
        { revalidate: true },
      );
    });
    expect(harness.success).toHaveBeenCalledWith(
      "Replay matching is running in the background.",
    );
  });
});

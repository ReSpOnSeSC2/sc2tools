import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "test-token"),
  userId: "test-user",
  query: "",
  replace: vi.fn(),
  isLoaded: true,
  isSignedIn: true,
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


vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: harness.replace }),
  useSearchParams: () => new URLSearchParams(harness.query),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    getToken: harness.getToken,
    userId: harness.userId,
    isLoaded: harness.isLoaded,
    isSignedIn: harness.isSignedIn,
  }),
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
  BuildFilterBar: ({ value, onChange, total, updating }: {
    value: { search: string; sort: string; matchup: string; hideEmpty: boolean };
    onChange: (next: unknown) => void;
    total: number; updating?: boolean;
  }) => <>
    <input aria-label="Search" value={value.search} onChange={(event) => onChange({ ...value, search: event.target.value })} />
    <select aria-label="Sort" value={value.sort} onChange={(event) => onChange({ ...value, sort: event.target.value })}>
      <option value="updated">Recently edited</option><option value="games">Most games</option>
    </select>
    <span>{total} matching builds</span>{updating ? <span role="status">Updating…</span> : null}
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
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} />,
}));

import { BuildsLibrary } from "./BuildsLibrary";

beforeEach(() => {
  harness.userId = "test-user";
  harness.query = ""; harness.replace.mockClear(); sessionStorage.clear();
  harness.isLoaded = true;
  harness.isSignedIn = true;
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

    expect(screen.getByText("Page 1 of 3 · builds 1–50 of 104")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.queryByRole("button", { name: "Edit Build 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Build 51" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Edit Build 104" })).toBeTruthy();
    expect(screen.getByText("Page 3 of 3 · builds 101–104 of 104")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    const statsPath = harness.paths.filter((path) => path.startsWith("/v1/custom-builds/stats?")).at(-1)!;
    expect(new URLSearchParams(statsPath.split("?")[1]).get("slugs")).toBe("build-101,build-102,build-103,build-104");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByRole("button", { name: "Edit Build 51" })).toBeTruthy();
  });

  it("runs search and sorting over the full library and resets the cursor", async () => {
    harness.listData = page(1, 50, "second");
    harness.listPages["cursor=second"] = page(51, 50, "third");
    harness.listPages["search=Build+104"] = { ...page(104, 1, null), total: 1 };
    harness.listPages["search=Build+104&sort=games"] = { ...page(104, 1, null), total: 1 };
    render(<BuildsLibrary />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "Build 104" } });

    expect(await screen.findByRole("button", { name: "Edit Build 104" })).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Finish editor save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Build 1" })).toBeTruthy());
    expect(harness.mutateBuilds).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("BuildsLibrary signed out", () => {
  beforeEach(() => {
    harness.isSignedIn = false;
    // Signed out, useApi has no key: the list never loads.
    harness.listData = undefined;
  });

  it("explains custom builds instead of loading a library forever", () => {
    const { container } = render(<BuildsLibrary />);
    expect(screen.getByRole("heading", { level: 1, name: "Your own build library" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How custom builds work" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /build editor/ }).getAttribute("src")).toBe("/landing/build-editor.png");
    // Never a skeleton: nothing on this page is waiting for data.
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(harness.paths).toEqual([]);
  });

  it("offers an account (returning to /builds) and the public build pages, never the editor", () => {
    render(<BuildsLibrary />);
    expect(screen.getByRole("link", { name: "Create account" }).getAttribute("href")).toBe("/sign-up?redirect_url=%2Fbuilds");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in?redirect_url=%2Fbuilds");
    expect(screen.getByRole("link", { name: "Browse community builds" }).getAttribute("href")).toBe("/community");
    expect(screen.getByRole("link", { name: "Build definitions" }).getAttribute("href")).toBe("/definitions");
    expect(screen.getByRole("link", { name: "Which pages are public?" }).getAttribute("href")).toBe(
      "/help/a-page-asked-me-to-sign-in",
    );
    expect(screen.queryByRole("button", { name: "New build" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reclassify/ })).toBeNull();
    expect(screen.queryByLabelText("Search")).toBeNull();
  });

  it("keeps the public intro visible until Clerk has loaded", () => {
    harness.isLoaded = false;
    const { container } = render(<BuildsLibrary />);
    expect(screen.getByRole("heading", { level: 1, name: "Your own build library" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse community builds" })).toBeTruthy();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(harness.paths).toEqual([]);
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
    // Points at the real entry point (a game's build order), not opponent profiles.
    expect(screen.getByText(/From any game’s build order, click ‘Save as new build’/)).toBeTruthy();
    expect(screen.queryByText(/opponent profile/)).toBeNull();
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
      name: "Re-match replays",
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

    fireEvent.click(screen.getByRole("button", { name: "Re-match replays" }));

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
    expect(screen.getByText(/40 replays checked so far/)).toBeTruthy();
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
          description: expect.stringContaining("5 games matched · 2 old matches removed"),
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
    fireEvent.click(await screen.findByRole("button", { name: "Finish editor save" }));

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

describe("build library navigation polish", () => {
  it("commits a typing burst only after 250 ms and writes committed filters to the URL", () => {
    vi.useFakeTimers();
    try {
      render(<BuildsLibrary />);
      const input = screen.getByRole("textbox", { name: "Search" });
      for (const value of ["b", "bli", "blink"]) fireEvent.change(input, { target: { value } });
      expect(harness.paths.some((path) => path.includes("search="))).toBe(false);
      act(() => vi.advanceTimersByTime(249));
      expect(harness.paths.some((path) => path.includes("search="))).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(new Set(harness.paths.filter((path) => path.includes("search=")))).toEqual(new Set(["/v1/custom-builds?search=blink"]));
      expect(harness.replace).toHaveBeenLastCalledWith("/builds?q=blink", { scroll: false });
    } finally { vi.useRealTimers(); }
  });
  it("reads URL filters and preserves cards while revalidating", () => {
    harness.query = "mu=PvT&sort=name&hide=1";
    const view = render(<BuildsLibrary />);
    expect(harness.paths).toContain("/v1/custom-builds?matchup=PvT&sort=name&hideEmpty=true");
    const card = screen.getByRole("button", { name: "Edit PvT Test Build" });
    harness.listValidating = true; view.rerender(<BuildsLibrary />);
    expect(screen.getByRole("button", { name: "Edit PvT Test Build" })).toBe(card);
    expect(screen.getByRole("status").textContent).toBe("Updating…");
  });
  it("does not claim no matches while an empty prior page is revalidating", () => {
    harness.query = "q=blink";
    harness.listData = { items: [], total: 0, libraryTotal: 2 };
    harness.listValidating = true;
    render(<BuildsLibrary />);
    expect(screen.queryByText("No builds match these filters")).toBeNull();
    expect(screen.getByText("Updating build matches…")).toBeTruthy();
  });
  it("restores a cursor page after leaving and returning to the same query", () => {
    harness.listData = { items: [{ slug: "one", name: "One" }], total: 2, nextCursor: "two", limit: 1 };
    harness.listPages["cursor=two"] = { items: [{ slug: "two", name: "Two" }], total: 2, nextCursor: null, limit: 1 };
    const view = render(<BuildsLibrary />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Edit Two" })).toBeTruthy();
    view.unmount(); render(<BuildsLibrary />);
    expect(screen.getByRole("button", { name: "Edit Two" })).toBeTruthy();
  });
  it("shows total progress and lets a failed job retry", async () => {
    harness.statusData = { status: "running", progress: { scanned: 40, total: 100 } };
    const view = render(<BuildsLibrary />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByText("40 of 100 replays checked")).toBeTruthy();
    harness.statusData = { status: "failed", error: "reclassify_queue_failed", requestId: "req-123" };
    view.rerender(<BuildsLibrary />);
    expect(screen.getByText("Error ID: req-123")).toBeTruthy();
    harness.apiCall.mockResolvedValue({ status: "queued", builds: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledWith(expect.anything(), "/v1/custom-builds/reclassify-all", expect.objectContaining({ method: "POST" })));
  });
});

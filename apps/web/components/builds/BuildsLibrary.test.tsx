import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "test-token"),
  mutateBuilds: vi.fn(async () => undefined),
  mutateStats: vi.fn(async () => undefined),
  mutateStatus: vi.fn(async () => undefined),
  statusData: undefined as undefined | Record<string, unknown>,
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: (path: string) =>
    path === "/v1/custom-builds"
      ? {
          data: {
            items: [{
              slug: "pvt-test",
              name: "PvT Test Build",
              race: "Protoss",
              vsRace: "Terran",
            }],
          },
          isLoading: false,
          error: null,
          mutate: harness.mutateBuilds,
        }
      : path === "/v1/custom-builds/stats"
        ? { data: [], isLoading: false, error: null, mutate: harness.mutateStats }
        : {
            data: harness.statusData,
            isLoading: false,
            error: null,
            mutate: harness.mutateStatus,
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
  }: {
    build: { slug: string; name: string };
    onReclassify: (slug: string) => void;
    onEdit: (slug: string) => void;
  }) => (
    <>
      <button type="button" onClick={() => onReclassify(build.slug)}>
        Reclassify {build.name}
      </button>
      <button type="button" onClick={() => onEdit(build.slug)}>
        Edit {build.name}
      </button>
    </>
  ),
}));

vi.mock("./BuildFilterBar", () => ({ BuildFilterBar: () => null }));
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
  harness.apiCall.mockReset();
  harness.getToken.mockClear();
  harness.mutateBuilds.mockClear();
  harness.mutateStats.mockClear();
  harness.mutateStatus.mockReset();
  harness.mutateStatus.mockResolvedValue(undefined);
  harness.statusData = undefined;
  harness.success.mockReset();
  harness.error.mockReset();
});

afterEach(cleanup);

describe("BuildsLibrary queued reclassification feedback", () => {
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

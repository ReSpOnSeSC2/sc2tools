import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "test-token"),
  mutateBuilds: vi.fn(async () => undefined),
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
      : { data: [], isLoading: false, error: null, mutate: vi.fn() },
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
  }: {
    build: { slug: string; name: string };
    onReclassify: (slug: string) => void;
  }) => (
    <button type="button" onClick={() => onReclassify(build.slug)}>
      Reclassify {build.name}
    </button>
  ),
}));

vi.mock("./BuildFilterBar", () => ({ BuildFilterBar: () => null }));
vi.mock("./BuildDossierModal", () => ({ BuildDossierModal: () => null }));
vi.mock("./BuildEditorSheet", () => ({ BuildEditorSheet: () => null }));
vi.mock("./EditCustomBuildLauncher", () => ({
  EditCustomBuildLauncher: () => null,
}));
vi.mock("./BuildPublishModal", () => ({ BuildPublishModal: () => null }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));

import { BuildsLibrary } from "./BuildsLibrary";

beforeEach(() => {
  harness.apiCall.mockReset();
  harness.getToken.mockClear();
  harness.mutateBuilds.mockClear();
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
});

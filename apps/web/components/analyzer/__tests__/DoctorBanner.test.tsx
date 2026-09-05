import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DoctorBanner } from "../DoctorBanner";
import { FALLBACK_LATEST_AGENT_VERSION } from "@/lib/agentNotice";

const useApiMock = vi.fn();
const useReleaseInfoMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("@/components/onboarding/useReleaseInfo", () => ({
  useReleaseInfo: (...args: unknown[]) => useReleaseInfoMock(...args),
}));

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  useReleaseInfoMock.mockReset();
});

describe("DoctorBanner replay archive prompt", () => {
  it("shows the update action and one-time Re-sync instruction", () => {
    useApiMock.mockReturnValue({
      data: {
        ok: false,
        warnings: [
          {
            id: "replay_archive_incomplete",
            severity: "warn",
            message:
              "14 saved games are missing the original replay file. Update to the latest desktop agent, then open it and click Re-sync once to enable downloads.",
            cta: { label: "Update agent", href: "/download" },
          },
        ],
      },
    });

    render(<DoctorBanner />);

    expect(screen.getByText(/14 saved games/i)).toBeTruthy();
    const action = screen.getByRole("link", { name: "Update agent" });
    expect(action.getAttribute("href")).toBe("/download");
    expect(useApiMock).toHaveBeenCalledWith("/v1/me/doctor", {
      refreshInterval: expect.any(Function),
    });
    const options = useApiMock.mock.calls[0]?.[1] as {
      refreshInterval: (latest?: {
        warnings?: Array<{ id: string }>;
      }) => number;
    };
    expect(options.refreshInterval({
      warnings: [{ id: "replay_archive_incomplete" }],
    })).toBe(30_000);
    expect(options.refreshInterval({ warnings: [] })).toBe(0);
  });

  it("stays out of the way after the archive is complete", () => {
    useApiMock.mockReturnValue({ data: { ok: true, warnings: [] } });

    const { container } = render(<DoctorBanner />);

    expect(container.firstChild).toBeNull();
    expect(useReleaseInfoMock).not.toHaveBeenCalled();
  });

  it("uses the latest-version message for a missing agent", () => {
    useReleaseInfoMock.mockReturnValue({ data: { latest: "0.17.4" } });
    useApiMock.mockReturnValue({
      data: {
        ok: false,
        warnings: [{
          id: "no_agent",
          severity: "warn",
          message: "legacy server copy",
          cta: { label: "Install latest agent", href: "/download" },
        }],
      },
    });

    render(<DoctorBanner />);

    expect(screen.getByText(
      "SC2 Tools Agent v0.17.4 needs to be turned on or installed",
    )).toBeTruthy();
    expect(screen.queryByText("legacy server copy")).toBeNull();
    expect(useReleaseInfoMock).toHaveBeenCalledWith("windows");
  });

  it("uses the bundled latest version while release metadata loads", () => {
    useReleaseInfoMock.mockReturnValue({ data: undefined, isLoading: true });
    useApiMock.mockReturnValue({
      data: {
        ok: false,
        warnings: [{
          id: "no_agent",
          severity: "warn",
          message: "legacy server copy",
        }],
      },
    });

    render(<DoctorBanner />);

    expect(screen.getByText(
      `SC2 Tools Agent v${FALLBACK_LATEST_AGENT_VERSION} needs to be turned on or installed`,
    )).toBeTruthy();
  });
});

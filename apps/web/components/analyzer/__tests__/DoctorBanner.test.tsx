import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DoctorBanner } from "../DoctorBanner";
import { FALLBACK_LATEST_AGENT_VERSION } from "@/lib/agentNotice";
import { loadLazyHelpLink } from "@/components/help/__tests__/loadLazyHelpLink";

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
    useReleaseInfoMock.mockReturnValue({ data: { latest: "9.9.9" } });
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
      "SC2 Tools Agent v9.9.9 needs to be turned on or installed",
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

describe("DoctorBanner Sync health warnings", () => {
  // Several warnings each show a help link; load the link's chunk once first.
  beforeAll(loadLazyHelpLink, 20_000);

  it("links each Sync health warning to its own help section and leaves older warnings as they were", () => {
    useApiMock.mockReturnValue({
      data: {
        ok: false,
        warnings: [
          { id: "agent_upload_failing", severity: "error", message: "The desktop app can't upload 4 games.", helpSlug: "desktop-app-status" },
          { id: "replays_skipped_unresolved", severity: "warn", message: "7 replays were skipped.", cta: { label: "Set up profile", href: "/settings?tab=profile" }, helpSlug: "my-game-didnt-show-up" },
          { id: "agent_outdated_required", severity: "warn", message: "Your desktop app is older than the minimum supported version.", cta: { label: "Update agent", href: "/download" }, helpSlug: "desktop-app-status" },
          { id: "uploads_rejected", severity: "warn", message: "SC2 Tools recently rejected 2 uploads.", helpSlug: "my-game-didnt-show-up" },
          { id: "agent_no_folders", severity: "warn", message: "No replay folder.", helpSlug: "desktop-app-status" },
          { id: "agent_paused", severity: "info", message: "Syncing is paused in the desktop app.", helpSlug: "desktop-app-status" },
          { id: "replay_archive_incomplete", severity: "warn", message: "14 saved games are missing the original replay file.", cta: { label: "Update agent", href: "/download" } },
        ],
      },
    });

    render(<DoctorBanner />);

    const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("How to fix uploads are failing")).toBe("/help/my-game-didnt-show-up#sync-upload-failing");
    expect(href("How to fix player not recognized")).toBe("/help/my-game-didnt-show-up#sync-player-unresolved");
    expect(href("How to fix update required")).toBe("/help/my-game-didnt-show-up#sync-update-required");
    expect(href("How to fix uploads rejected")).toBe("/help/my-game-didnt-show-up#sync-uploads-rejected");
    expect(href("How to fix no replay folder")).toBe("/help/my-game-didnt-show-up#sync-no-folder");
    expect(screen.getByText("The desktop app can't upload 4 games.").closest("li")?.className).toContain("border-danger/40");
    expect(screen.getAllByRole("link", { name: "Update agent" })).toHaveLength(2);
    // Paused is the owner's own choice (info), so the banner leaves it out.
    expect(screen.queryByText(/Syncing is paused/)).toBeNull();
    // An older warning keeps its markup: a message and its action, no help link.
    const archive = screen.getByText(/14 saved games/);
    expect(archive.parentElement?.tagName).toBe("LI");
    expect(screen.getAllByRole("link", { name: /^How to fix/ })).toHaveLength(5);
  });

  it("follows the help article a newer warning names, and ignores a malformed one", () => {
    useApiMock.mockReturnValue({
      data: {
        ok: false,
        warnings: [
          { id: "future_check", severity: "warn", message: "Future issue", helpSlug: "setup-health" },
          { id: "odd_check", severity: "warn", message: "Odd issue", helpSlug: "../etc" },
        ],
      },
    });

    render(<DoctorBanner />);

    expect(screen.getByRole("link", { name: "How to fix" }).getAttribute("href")).toBe("/help/setup-health");
    expect(screen.getByText("Odd issue")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /How to fix/ })).toHaveLength(1);
  });
});

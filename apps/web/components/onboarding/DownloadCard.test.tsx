import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadCard } from "./DownloadCard";

const { gaEventMock, usePlatformDetectMock, useReleaseInfoMock, useIsMobileDeviceMock } = vi.hoisted(
  () => ({
    gaEventMock: vi.fn(),
    usePlatformDetectMock: vi.fn(),
    useReleaseInfoMock: vi.fn(),
    useIsMobileDeviceMock: vi.fn(() => false),
  }),
);

vi.mock("./useIsMobileDevice", () => ({
  useIsMobileDevice: () => useIsMobileDeviceMock(),
}));

vi.mock("./usePlatformDetect", () => ({
  usePlatformDetect: () => usePlatformDetectMock(),
}));

vi.mock("./useReleaseInfo", () => ({
  useReleaseInfo: (...args: unknown[]) => useReleaseInfoMock(...args),
  formatBytes: (bytes: number | null | undefined) => `${bytes ?? 0} B`,
}));

vi.mock("@/lib/analytics/gtag", () => ({
  gaEvent: (...args: unknown[]) => gaEventMock(...args),
}));

describe("DownloadCard", () => {
  beforeEach(() => {
    gaEventMock.mockReset();
    usePlatformDetectMock.mockReset();
    usePlatformDetectMock.mockReturnValue("windows");
    useReleaseInfoMock.mockReset();
    useReleaseInfoMock.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        latest: "0.15.20",
        publishedAt: "2026-08-13T12:00:00.000Z",
        releaseNotes: "Release notes",
        artifact: {
          downloadUrl: "https://github.test/direct-installer.exe",
          sha256: "a".repeat(64),
          sizeBytes: 1024,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    useIsMobileDeviceMock.mockReturnValue(false);
    vi.unstubAllEnvs();
  });

  it("sends phone and tablet visitors to their PC instead of offering an installer", () => {
    useIsMobileDeviceMock.mockReturnValue(true);
    render(<DownloadCard />);
    expect(screen.getByRole("heading", { name: "Install it on your PC" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Download for/ })).toBeNull();
  });

  it("points Mac visitors at the in-browser analyzer and python3", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
    useReleaseInfoMock.mockReturnValue({ isLoading: false, error: null, data: { artifact: null } });
    render(<DownloadCard os="macos" />);
    expect(screen.getByRole("link", { name: "Open the replay analyzer" }).getAttribute("href")).toBe("/try");
    expect(screen.getByText(/python3 -m sc2tools_agent/)).toBeTruthy();
  });

  it("posts the resolved installer through the tracked server redirect", () => {
    render(<DownloadCard os="windows" />);
    const button = screen.getByRole("button", { name: "Download for Windows" });
    const form = button.closest("form");
    expect(form?.getAttribute("action")).toBe("/api/download/agent");
    expect(form?.getAttribute("method")).toBe("post");
    expect(
      form?.querySelector<HTMLInputElement>('input[name="platform"]')?.value,
    ).toBe("windows");
    expect(
      form?.querySelector<HTMLInputElement>('input[name="artifactUrl"]')?.value,
    ).toBe("https://github.test/direct-installer.exe");

    form?.addEventListener("submit", (event) => event.preventDefault());
    fireEvent.submit(form as HTMLFormElement);
    expect(gaEventMock).toHaveBeenCalledOnce();
    expect(gaEventMock).toHaveBeenCalledWith("agent_download", {
      platform: "windows",
      version: "0.15.20",
    });
  });
});

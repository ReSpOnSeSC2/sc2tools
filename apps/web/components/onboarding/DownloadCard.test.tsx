import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadCard } from "./DownloadCard";

const { gaEventMock, usePlatformDetectMock, useReleaseInfoMock } = vi.hoisted(
  () => ({
    gaEventMock: vi.fn(),
    usePlatformDetectMock: vi.fn(),
    useReleaseInfoMock: vi.fn(),
  }),
);

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

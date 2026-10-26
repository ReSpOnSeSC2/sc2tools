import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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


describe("release recovery", () => {
  afterEach(cleanup);
it("distinguishes release-server errors from an empty release and retries with busy feedback", async () => {
  let finish!: () => void;
  const mutate = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  useReleaseInfoMock.mockReturnValue({ isLoading: false, error: new Error("rate limited"), mutate });
  render(<DownloadCard os="windows" />);
  expect(screen.getByRole("heading", { name: "Couldn't reach the release server" })).toBeTruthy();
  expect(screen.queryByText(/No installer published yet/)).toBeNull();
  expect(screen.getByRole("link", { name: "Download from GitHub Releases" }).getAttribute("href")).toBe("https://github.com/ReSpOnSeSC2/sc2tools/releases");
  const retry = screen.getByRole("button", { name: "Retry" }); fireEvent.click(retry);
  expect(mutate).toHaveBeenCalledOnce(); expect(retry.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish());
  await waitFor(() => expect(retry.getAttribute("aria-busy")).not.toBe("true"));
});
it("waits for a successful response before claiming no installer is published", () => {
  useReleaseInfoMock.mockReturnValue({ isLoading: false, error: null, data: undefined });
  render(<DownloadCard os="windows" />);
  expect(screen.getByLabelText("Loading the latest release")).toBeTruthy(); expect(screen.queryByText(/No installer published/)).toBeNull();
});
it("shows no-installer instructions only after a successful empty release", () => {
  useReleaseInfoMock.mockReturnValue({ isLoading: false, error: null, data: { artifact: null } });
  render(<DownloadCard os="linux" />);
  expect(screen.getByRole("heading", { name: "No installer published yet for Linux" })).toBeTruthy();
  expect(screen.queryByText(/Couldn't reach/)).toBeNull();
});
it.each(["windows", "macos", "linux"] as const)("admits the %s source commands to keyboard focus", os => {
  useReleaseInfoMock.mockReturnValue({ isLoading: false, error: null, data: { artifact: null } });
  render(<DownloadCard os={os} />);
  const commands = screen.getByRole("region", { name: "Source installation commands" });
  expect(commands.tagName).toBe("PRE"); expect(commands.tabIndex).toBe(0);
  commands.focus(); expect(document.activeElement).toBe(commands);
});
it("keeps release notes plain-safe behind an accessible toggle and links all releases", () => {
  useReleaseInfoMock.mockReturnValue({ isLoading: false, data: { latest: "0.19.0", artifact: { downloadUrl: "https://example.com/a.exe", sha256: "a", sizeBytes: 100 }, releaseNotes: "## Changes\n- **A fix**\n<script>unsafe</script>" } });
  const { container } = render(<DownloadCard os="windows" />);
  const notes = screen.getByRole("button", { name: "Release notes" }); expect(notes.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(notes); expect(notes.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("A fix").tagName).toBe("STRONG"); expect(container.querySelector("script")).toBeNull();
  expect(document.getElementById(notes.getAttribute("aria-controls")!)).toBeTruthy();
  expect(screen.getByRole("link", { name: "All releases" }).getAttribute("href")).toContain("/releases");
});

});

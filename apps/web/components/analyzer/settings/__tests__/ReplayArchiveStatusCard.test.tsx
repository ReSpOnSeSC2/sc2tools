import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  normalizeReplayArchiveStatus,
  ReplayArchiveStatusCard,
} from "../ReplayArchiveStatusCard";
import { SettingsBackups } from "../SettingsBackups";
import { ToastProvider } from "@/components/ui/Toast";

const useApiMock = vi.fn();
const apiCallMock = vi.fn();
const getTokenMock = vi.fn(async () => "test-token");

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: getTokenMock }),
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
  apiCall: (...args: unknown[]) => apiCallMock(...args),
  API_BASE: "https://api.example.test",
}));

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
  apiCallMock.mockReset();
  getTokenMock.mockClear();
});

const BASE = {
  totalGames: 9,
  archivedGames: 7,
  missingGames: 2,
  archiveComplete: false,
  enabled: true,
  backfillVersion: 0,
  resyncRequestedAt: null,
  requiresResync: true,
} as const;

describe("ReplayArchiveStatusCard", () => {
  it("shows honest coverage and the latest-agent full re-sync action", () => {
    useApiMock.mockReturnValue({
      data: { ...BASE, bucket: "must-never-render" },
      isLoading: false,
      error: null,
    });

    render(<ReplayArchiveStatusCard />);

    expect(screen.getByText("Full re-sync required")).toBeTruthy();
    expect(screen.getByTestId("archive-archived-count").textContent).toBe("7");
    expect(screen.getByTestId("archive-missing-count").textContent).toBe("2");
    expect(screen.getByRole("progressbar", { name: "Replay archive coverage" }).getAttribute("aria-valuenow")).toBe("7");
    expect(screen.getByText(/choose All time/i)).toBeTruthy();
    expect(screen.getByText(/Re-sync replay library once/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download latest agent" }).getAttribute("href")).toBe("/download");
    expect(screen.queryByText("must-never-render")).toBeNull();

    const options = useApiMock.mock.calls[0]?.[1] as {
      refreshInterval: (latest: unknown) => number;
      revalidateOnFocus: boolean;
    };
    expect(options.revalidateOnFocus).toBe(true);
    expect(options.refreshInterval(BASE)).toBe(30_000);
  });

  it("shows a completed private archive without asking for another scan", () => {
    useApiMock.mockReturnValue({
      data: {
        ...BASE,
        archivedGames: 9,
        missingGames: 0,
        archiveComplete: true,
        backfillVersion: 1,
        resyncRequestedAt: "2026-08-11T16:30:00.000Z",
        requiresResync: false,
      },
      isLoading: false,
      error: null,
    });

    render(<ReplayArchiveStatusCard />);

    expect(screen.getByText("Archive up to date")).toBeTruthy();
    expect(screen.getByText(/Every saved game has its original replay archived privately/i)).toBeTruthy();
    expect(screen.getByTestId("archive-coverage").textContent).toBe("100%");
    expect(screen.queryByText("Full re-sync required")).toBeNull();
    expect(screen.getByRole("link", { name: "Check for agent updates" })).toBeTruthy();
  });

  it("distinguishes an acknowledged partial scan from a repeat prompt", () => {
    useApiMock.mockReturnValue({
      data: {
        ...BASE,
        backfillVersion: 1,
        resyncRequestedAt: "2026-08-11T16:30:00.000Z",
        requiresResync: false,
      },
      isLoading: false,
      error: null,
    });

    render(<ReplayArchiveStatusCard />);

    expect(screen.getAllByText("Full re-sync started").length).toBeGreaterThan(0);
    expect(screen.getByText(/you do not need to restart the scan/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download latest agent" })).toBeNull();
    expect(screen.getByRole("link", { name: "View re-sync guide" })).toBeTruthy();
  });

  it("does not present disabled or malformed status as zero archive usage", () => {
    useApiMock.mockReturnValue({
      data: {
        ...BASE,
        totalGames: 0,
        archivedGames: 0,
        missingGames: 0,
        archiveComplete: true,
        enabled: false,
        requiresResync: false,
      },
      isLoading: false,
      error: null,
    });
    const { rerender } = render(<ReplayArchiveStatusCard />);

    expect(screen.getByText("Cloud archive unavailable")).toBeTruthy();
    expect(screen.queryByTestId("archive-archived-count")).toBeNull();

    useApiMock.mockReturnValue({
      data: { ...BASE, archivedGames: 99 },
      isLoading: false,
      error: null,
    });
    rerender(<ReplayArchiveStatusCard />);
    expect(screen.getByText("Archive status temporarily unavailable")).toBeTruthy();
  });

  it("is mounted at the top of the regular Backups & data settings surface", () => {
    useApiMock.mockImplementation((path: string) => {
      if (path === "/v1/me/backups") {
        return {
          data: { items: [] },
          isLoading: false,
          error: null,
          mutate: vi.fn(),
        };
      }
      return { data: BASE, isLoading: false, error: null };
    });

    render(
      <ToastProvider>
        <SettingsBackups />
      </ToastProvider>,
    );

    expect(screen.getByText("Cloud Replay Archive")).toBeTruthy();
    expect(screen.getByText("Snapshots")).toBeTruthy();
    expect(useApiMock).toHaveBeenCalledWith(
      "/v1/me/replay-archive-status",
      expect.objectContaining({ revalidateOnFocus: true }),
    );
  });
});

describe("normalizeReplayArchiveStatus", () => {
  it("rejects inconsistent counts and accepts the documented contract", () => {
    expect(normalizeReplayArchiveStatus(BASE)).toEqual(BASE);
    expect(normalizeReplayArchiveStatus({ ...BASE, missingGames: 3 })).toBeNull();
    expect(normalizeReplayArchiveStatus({ ...BASE, archiveComplete: true })).toBeNull();
  });
});

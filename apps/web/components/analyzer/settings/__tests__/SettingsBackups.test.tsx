import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsBackups } from "../SettingsBackups";
import { ToastProvider } from "@/components/ui/Toast";

const useApiMock = vi.fn();
const apiCallMock = vi.fn();
const mutateMock = vi.fn(async () => undefined);

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token", isLoaded: true, isSignedIn: true }),
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
  mutateMock.mockClear();
});

const SNAPSHOT = {
  id: "bk_1754900000000_abcd",
  createdAt: "2026-08-11T09:30:00.000Z",
  sizeBytes: 2_097_152,
  type: "manual",
} as const;

function renderBackups(items: unknown[] = [SNAPSHOT]) {
  useApiMock.mockImplementation((path: string) => {
    if (path === "/v1/me/backups") {
      return { data: { items }, isLoading: false, error: null, mutate: mutateMock };
    }
    // Replay archive card: leave it in its "unavailable" state.
    return { data: null, isLoading: false, error: null };
  });
  return render(
    <ToastProvider>
      <SettingsBackups />
    </ToastProvider>,
  );
}

describe("SettingsBackups copy", () => {
  it("describes snapshots, the daily backup and the export as they really work", () => {
    renderBackups([]);

    expect(screen.getByText(/Your own restore points for your account/)).toBeTruthy();
    expect(screen.getByText(/Build orders, charts and original replay files/)).toBeTruthy();
    expect(screen.getByText(/backed up every day\s+with MongoDB Atlas/)).toBeTruthy();
    expect(screen.getByText(/can't bring back just your account/)).toBeTruthy();
    expect(screen.queryByText(/continuous backups/i)).toBeNull();
    expect(screen.getByRole("link", { name: "How backups work" }).getAttribute("href"))
      .toBe("/help/backups-and-export");
    expect(screen.getByText(/Build orders and charts aren't in the file/)).toBeTruthy();
    expect(screen.queryByText(/ML model artifact/)).toBeNull();
  });
});

describe("SettingsBackups restore", () => {
  it("says what a restore replaces, then confirms it finished", async () => {
    apiCallMock.mockResolvedValue({ restoredAt: "2026-08-11T10:00:00.000Z", counts: {} });
    renderBackups();

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Games added since then are removed/)).toBeTruthy();
    expect(within(dialog).getByText(/click Re-sync in the desktop app/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByText("Snapshot restored")).toBeTruthy());
    expect(apiCallMock).toHaveBeenCalledWith(
      expect.any(Function),
      `/v1/me/backups/${SNAPSHOT.id}/restore`,
      { method: "POST", body: "{}" },
    );
    expect(screen.queryByText("Restore queued")).toBeNull();
  });
});

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevicesPanel } from "../DevicesPanel";

const h = vi.hoisted(() => ({ apiCall: vi.fn(), mutate: vi.fn(), data: { items: [] as object[] } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => h.apiCall(...args), useApi: () => ({ data: h.data, mutate: h.mutate }) }));
vi.mock("@/components/onboarding/PairDeviceForm", () => ({ PairDeviceForm: () => <p>Shared pairing form</p> }));
vi.mock("@/components/onboarding/useReleaseInfo", () => ({ useReleaseInfo: () => ({ data: { latest: "0.20.0" } }) }));

beforeEach(() => { h.apiCall.mockReset(); h.apiCall.mockResolvedValue(null); h.mutate.mockReset(); h.data = { items: [] }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function device(overrides = {}) {
  return { deviceId: "device-1", hostname: "GAMING-PC", createdAt: new Date(Date.now() - 86400_000).toISOString(), lastSeenAt: new Date().toISOString(), agentVersion: "0.19.0", agentOs: "Windows", ...overrides };
}

describe("Devices page cards", () => {
  it("shows a genuine empty state alongside shared pairing and download", () => {
    render(<DevicesPanel />);
    expect(screen.getByText("No PCs paired yet")).toBeTruthy();
    expect(screen.getByText("Shared pairing form")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download the agent" }).getAttribute("href")).toBe("/download");
  });

  it("labels fresh/offline devices and shows an update only for an older known version", () => {
    h.data.items = [device(), device({ deviceId: "device-2", hostname: "LAPTOP", lastSeenAt: new Date(Date.now() - 2 * 86400_000).toISOString(), agentVersion: "0.20.0" })];
    render(<DevicesPanel />);
    expect(screen.getByText("Online")).toBeTruthy(); expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Update available → v0.20.0" })).toHaveLength(1);
    expect(screen.getByText(/Paired .*seen 2d ago/)).toBeTruthy();
  });

  it("retains a failed label edit, then retries the user's current label", async () => {
    h.data.items = [device()]; h.apiCall.mockRejectedValueOnce({ message: "Couldn't save" });
    render(<DevicesPanel />);
    const field = screen.getByRole("textbox", { name: "Label for GAMING-PC" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Desktop" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save label" })); });
    expect(field.value).toBe("Desktop"); expect(screen.getByRole("alert").textContent).toBe("Couldn't save");
    fireEvent.change(field, { target: { value: "Gaming desktop" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save label" })); });
    expect(h.apiCall.mock.calls[1][2]).toMatchObject({ method: "PATCH", body: JSON.stringify({ label: "Gaming desktop" }) });
    expect(screen.getByRole("status").textContent).toBe("Label saved.");
  });

  it("recognizes a new heartbeat received between status-clock ticks", () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    h.data.items = [device({ lastSeenAt: null })];
    const view = render(<DevicesPanel />);
    expect(screen.getByText("Offline")).toBeTruthy();
    clock.mockReturnValue(started + 1000);
    h.data.items = [device()];
    view.rerender(<DevicesPanel />);
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("requires typed confirmation before unpairing and keeps the dialog available after a failure", async () => {
    h.data.items = [device()]; h.apiCall.mockRejectedValueOnce({ message: "Try again" });
    render(<DevicesPanel />); fireEvent.click(screen.getByRole("button", { name: "Unpair" }));
    expect(h.apiCall).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Unpair PC" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Type UNPAIR to confirm" }), { target: { value: "UNPAIR" } });
    await act(async () => { fireEvent.click(confirm); });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(h.apiCall.mock.calls[0][1]).toBe("/v1/devices/device-1");
    await act(async () => { fireEvent.click(confirm); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.mutate).toHaveBeenCalled();
  });
});

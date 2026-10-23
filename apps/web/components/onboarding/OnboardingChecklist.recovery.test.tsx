import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingChecklist, type ChecklistMe } from "./OnboardingChecklist";
import { ToastProvider } from "@/components/ui/Toast";

const h = vi.hoisted(() => ({ apiCall: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "account-token" }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => h.apiCall(...args) }));
vi.mock("@/components/imports/useImportStatus", () => ({ useImportStatus: () => ({ job: null, active: false, pct: 0, refresh: vi.fn() }) }));
vi.mock("./PairDeviceForm", () => ({ PairDeviceForm: ({ onPaired, onConnected }: { onPaired: () => void; onConnected: (device: object) => void }) => <><button onClick={onPaired}>Link fixture PC</button><button onClick={() => onConnected({ hostname: "GAMING-PC" })}>Confirm connection</button></> }));

const base: ChecklistMe = { games: { total: 0 }, agentPaired: false };
beforeEach(() => { vi.useFakeTimers(); h.apiCall.mockReset(); h.apiCall.mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function show(me = base) { return render(<ToastProvider><OnboardingChecklist me={me} /></ToastProvider>); }

describe("dashboard setup recovery", () => {
  it("shows the count and accessible progress", async () => {
    show({ ...base, onboarding: { downloadStartedAt: "earlier" } });
    expect(screen.getByText(/1 of 3 done/)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Setup progress" }).getAttribute("aria-valuenow")).toBe("1");
    await act(async () => { await vi.dynamicImportSettled(); });
  });
  it("Undo cancels dismissal without any preference PUT", async () => {
    show(); fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("onboarding-checklist")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(screen.getByTestId("onboarding-checklist")).toBeTruthy(); expect(h.apiCall).not.toHaveBeenCalled();
  });
  it("commits exactly once after five seconds with only the changed field", async () => {
    show(); fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await act(async () => { vi.advanceTimersByTime(4999); }); expect(h.apiCall).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(h.apiCall).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(h.apiCall.mock.calls[0][2].body))).toEqual(["dismissedAt"]);
    await act(async () => { vi.advanceTimersByTime(10000); }); expect(h.apiCall).toHaveBeenCalledTimes(1);
  });
  it("commits pending dismissal when navigating away and clears its timer", async () => {
    const view = show(); fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await act(async () => { view.unmount(); });
    expect(h.apiCall).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(6000); }); expect(h.apiCall).toHaveBeenCalledTimes(1);
  });
  it("restores the checklist if the delayed save fails", async () => {
    h.apiCall.mockRejectedValueOnce(new Error("offline"));
    show(); fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(screen.getByTestId("onboarding-checklist")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't hide the setup checklist");
  });
  it("keeps inline pairing mounted until the actual connection is confirmed", async () => {
    const me = { ...base, onboarding: { downloadStartedAt: "earlier" } };
    const view = show(me); await act(async () => { await vi.dynamicImportSettled(); }); fireEvent.click(screen.getByRole("button", { name: "Link fixture PC" }));
    view.rerender(<ToastProvider><OnboardingChecklist me={{ ...me, agentPaired: true, agentLastSeenAt: new Date().toISOString() }} /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Confirm connection" }));
    expect(screen.getByText("Connected: GAMING-PC")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link fixture PC" })).toBeNull();
  });
});

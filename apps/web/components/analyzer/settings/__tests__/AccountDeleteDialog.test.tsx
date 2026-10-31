import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AccountDeleteDialog from "../AccountDeleteDialog";

const apiCall = vi.fn(), signOut = vi.fn(), mutate = vi.fn();
const forgetDeviceCopy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysisCorpus/deviceClear", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysisCorpus/deviceClear")>()),
  forgetDeviceCopy,
}));
const state = { inventory: { data: { removed: { games: 12, devices: 2 }, anonymized: { reviewComments: 3 }, countedAt: "2026-10-23" } as unknown, error: null as unknown, mutate } };
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "session" }), useClerk: () => ({ signOut }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => apiCall(...args), useApi: () => state.inventory, API_BASE: "https://fixture.local" }));
vi.mock("@/components/legal/BackupRetention", () => ({ BackupRetention: () => <p>Current database backup retention: 7 days.</p> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); state.inventory.data = { removed: { games: 12, devices: 2 }, anonymized: { reviewComments: 3 }, countedAt: "2026-10-23" }; state.inventory.error = null; });
const open = () => render(<AccountDeleteDialog onClose={vi.fn()} onExport={async () => true} />);
function finalStep() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
}

describe("account erasure dialog", () => {
  it("offers export before showing live removed/anonymized counts and exact confirmation", async () => {
    const onExport = vi.fn(async () => true);
    render(<AccountDeleteDialog onClose={vi.fn()} onExport={onExport} />);
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Games and analysis").parentElement?.textContent).toBe("Games and analysis12");
    expect(screen.getByText("Comments on other review requests").parentElement?.textContent).toBe("Comments on other review requests3");
    expect(screen.getByText(/remain as \[deleted user\]/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Delete account permanently" }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "delete" } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Delete account permanently" }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    apiCall.mockResolvedValueOnce({ deleted: true }); signOut.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Delete account permanently" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledWith({ redirectUrl: "/goodbye" }));
    expect(apiCall).toHaveBeenCalledWith(expect.any(Function), "/v1/me", { method: "DELETE" });
    // The erased account's history left this device before sign-out.
    expect(forgetDeviceCopy).toHaveBeenCalledTimes(1);
    expect(forgetDeviceCopy.mock.invocationCallOrder[0]).toBeLessThan(signOut.mock.invocationCallOrder[0]);
  });
  it("blocks confirmation while inventory failed, with an explicit retry", () => {
    state.inventory.data = null; state.inventory.error = { status: 503 };
    open(); fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load your data inventory");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry inventory" })); expect(mutate).toHaveBeenCalledTimes(1);
  });
  it("keeps the copy kept on this device when erasure is rejected outright", async () => {
    apiCall.mockRejectedValueOnce({ status: 403, code: "forbidden" }); open(); finalStep();
    fireEvent.click(screen.getByRole("button", { name: "Delete account permanently" }));
    await screen.findByRole("alert");
    expect([signOut.mock.calls.length, forgetDeviceCopy.mock.calls.length]).toEqual([0, 0]);
  });
  it("preserves DELETE and retries deletion after a purge error without signing out early", async () => {
    apiCall.mockRejectedValueOnce(new Error("offline")); open(); finalStep();
    fireEvent.click(screen.getByRole("button", { name: "Delete account permanently" }));
    // The erasure may have gone through before the answer was lost, so the copy here goes already.
    await screen.findByRole("alert"); expect(signOut).not.toHaveBeenCalled(); expect(forgetDeviceCopy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText<HTMLInputElement>("Type DELETE to confirm").value).toBe("DELETE");
    apiCall.mockResolvedValueOnce({ deleted: true }); signOut.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Delete account permanently" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });
  it("retries only sign-out after successful erasure and sign-out failure", async () => {
    apiCall.mockResolvedValueOnce({ deleted: true }); signOut.mockRejectedValueOnce(new Error("offline")); open(); finalStep();
    fireEvent.click(screen.getByRole("button", { name: "Delete account permanently" }));
    await screen.findByText("Your data was deleted. Signing out failed; retry signing out.");
    // Cleared once, after the erasure; the failed sign-out clears nothing more.
    expect(forgetDeviceCopy).toHaveBeenCalledTimes(1);
    signOut.mockResolvedValueOnce(undefined);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry signing out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2)); expect(apiCall).toHaveBeenCalledTimes(1);
  });
  it("finishes sign-out after a lost deletion response is confirmed by the explicit deletion guard", async () => {
    apiCall.mockRejectedValueOnce({ status: 401, code: "account_deleted" }); signOut.mockResolvedValueOnce(undefined); open(); finalStep();
    fireEvent.click(screen.getByRole("button", { name: "Delete account permanently" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledWith({ redirectUrl: "/goodbye" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(forgetDeviceCopy).toHaveBeenCalledTimes(1);
    expect(forgetDeviceCopy.mock.invocationCallOrder[0]).toBeLessThan(signOut.mock.invocationCallOrder[0]);
  });
});

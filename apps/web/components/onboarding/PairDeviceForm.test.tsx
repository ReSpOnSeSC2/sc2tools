import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairDeviceForm } from "./PairDeviceForm";
import { normalizePairingCode } from "./pairingTypes";

const h = vi.hoisted(() => ({ apiCall: vi.fn(), replace: vi.fn(), query: "code=123-456&src=agent", userId: "user-a" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: h.userId, getToken: async () => "token" }) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(h.query), usePathname: () => "/devices", useRouter: () => ({ replace: h.replace }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => h.apiCall(...args) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));

const INFO = { sameNetwork: false, device: { deviceId: "new-device", hostname: "GAMING-PC", os: "Windows 11", version: "0.20.0" } };
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
async function pair() { await click("Link this PC"); await click("Link GAMING-PC"); }

beforeEach(() => {
  vi.useFakeTimers(); h.apiCall.mockReset(); h.replace.mockReset(); h.userId = "user-a"; h.query = "code=123-456&src=agent";
  h.apiCall.mockImplementation(async (_token, path) => path === "/v1/devices" ? { items: [] } : INFO);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("shared PC pairing", () => {
  it("normalizes all separators before capping, prefills without submitting, and requires explicit confirmation", async () => {
    expect(normalizePairingCode("1a2 /3-4 5z6 789")).toBe("123456");
    render(<PairDeviceForm />);
    const input = screen.getByRole("textbox", { name: "6-digit pairing code" }) as HTMLInputElement;
    expect(input.value).toBe("123456"); expect(input.getAttribute("maxlength")).toBeNull();
    expect(h.apiCall).not.toHaveBeenCalled();
    await click("Link this PC");
    expect(h.apiCall).toHaveBeenCalledTimes(1);
    expect(h.apiCall.mock.calls[0][1]).toBe("/v1/device-pairings/123456/preview");
    expect(screen.getByText("Link GAMING-PC (Windows 11, v0.20.0)?")).toBeTruthy();
    expect(screen.getByText("Only pair a code shown by SC2 Tools on your own PC.")).toBeTruthy();
    await click("Link GAMING-PC");
    expect(h.apiCall.mock.calls[1][2]).toMatchObject({ method: "POST", body: JSON.stringify({ code: "123456" }) });
    expect(h.replace).toHaveBeenCalledWith("/devices?src=agent", { scroll: false });
  });

  it("moves focus to the button after six typed digits and never auto-claims", () => {
    h.query = ""; render(<PairDeviceForm compact />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "123 456" } });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Link this PC" }));
    expect(h.apiCall).not.toHaveBeenCalled();
  });

  it("connects only the claimed PC after a real heartbeat and stops polling", async () => {
    const paired = vi.fn(); const connected = vi.fn();
    let polls = 0;
    h.apiCall.mockImplementation(async (_token, path) => {
      if (path !== "/v1/devices") return INFO;
      polls++;
      return { items: [{ deviceId: polls === 1 ? "another-PC" : INFO.device.deviceId, hostname: "GAMING-PC", agentVersion: "0.20.0", lastSeenAt: new Date().toISOString() }] };
    });
    render(<PairDeviceForm onPaired={paired} onConnected={connected} />); await pair();
    expect(paired).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(connected).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole("status").textContent).toBe("Connected: GAMING-PC, v0.20.0");
    expect(connected).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(60_000)); expect(polls).toBe(2);
  });

  it("bounds the wait to a minute and offers pairing help without losing the successful link", async () => {
    render(<PairDeviceForm />); await pair();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByRole("status").textContent).toBe("Paired — waiting for the app to check in");
    expect(screen.getByRole("link", { name: "Help with the connection" }).getAttribute("href")).toBe("/help/pairing-troubleshooting");
    const calls = h.apiCall.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000)); expect(h.apiCall).toHaveBeenCalledTimes(calls);
  });

  it("keeps a failed code available and displays the readable API error", async () => {
    h.apiCall.mockRejectedValue({ status: 404, message: "That code has expired or doesn't exist." });
    render(<PairDeviceForm />); await click("Link this PC");
    expect(screen.getByRole("alert").textContent).toContain("expired");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("123456");
  });

  it("times out a stalled request, aborts it, and restores the form", async () => {
    h.apiCall.mockReturnValue(new Promise(() => {}));
    render(<PairDeviceForm />); await click("Link this PC");
    const signal = h.apiCall.mock.calls[0][2].signal as AbortSignal;
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("timed out");
    expect((screen.getByRole("button", { name: "Link this PC" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("cleans up timers on unmount and discards another account's pairing state", async () => {
    const view = render(<PairDeviceForm />); await pair();
    h.userId = "user-b"; view.rerender(<PairDeviceForm />);
    expect(screen.getByRole("button", { name: "Link this PC" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    view.unmount(); const calls = h.apiCall.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000)); expect(h.apiCall).toHaveBeenCalledTimes(calls);
  });
});

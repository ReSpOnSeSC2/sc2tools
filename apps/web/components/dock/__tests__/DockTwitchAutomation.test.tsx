import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DockTwitchAutomation } from "../DockTwitchAutomation";
const current = { gameKey: "fixture-game", prediction: "active", marker: "created", canCancel: true, canResolve: false, deadlineAt: null, reason: null };
const snapshot = { current, serverEnabled: true, reason: null, predictionsEnabled: true, markersEnabled: true };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => { fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? json({ current: { ...current, prediction: "canceled", canCancel: false } }) : json(snapshot)); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("Cancel defaults to the safe action and sends no mutation before confirmation", async () => {
  render(<DockTwitchAutomation token="owned" />); await screen.findByText("Prediction · Open"); fireEvent.click(screen.getByRole("button", { name: "Cancel / refund" }));
  const dialog = screen.getByRole("dialog"); expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })); expect(fetcher.mock.calls.every(call => call[1]?.method !== "POST")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel / refund" })); fireEvent.click(screen.getByRole("button", { name: "Request refund" }));
  await screen.findByText("Twitch confirmed cancellation and refunded the prediction."); const write = fetcher.mock.calls.find(call => call[1]?.method === "POST"); expect(JSON.parse(String(write?.[1]?.body))).toEqual({ action: "cancel", gameKey: "fixture-game", confirmed: true });
});
it("a server-off gate disables actions and an unconfirmed missing ID has no refund CTA", async () => {
  fetcher.mockResolvedValue(json({ ...snapshot, serverEnabled: false, reason: "server_not_enabled" })); const view = render(<DockTwitchAutomation token="owned" />); await screen.findByText("Prediction · Open");
  expect(screen.getByRole("button", { name: "Cancel / refund" }).hasAttribute("disabled")).toBe(true);
  fetcher.mockResolvedValue(json({ ...snapshot, current: { ...current, prediction: "unknown", canCancel: false, reason: "provider_unconfirmed" } })); view.rerender(<DockTwitchAutomation token="new" />); await screen.findByText("Prediction · Unconfirmed");
  expect(screen.queryByRole("button", { name: "Cancel / refund" })).toBeNull(); expect(screen.getByText(/prediction ID was not confirmed/)).toBeTruthy();
});
it("late resolution/cancel response never claims a refund unless Twitch reports canceled", async () => {
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? json({ current: { ...current, prediction: "resolved", canCancel: false } }) : json(snapshot));
  render(<DockTwitchAutomation token="owned" />); await screen.findByText("Prediction · Open"); fireEvent.click(screen.getByRole("button", { name: "Cancel / refund" })); fireEvent.click(screen.getByRole("button", { name: "Request refund" }));
  await screen.findByText("Twitch reports this prediction is resolved."); expect(screen.queryByText("Twitch confirmed cancellation and refunded the prediction.")).toBeNull();
});
it("a token switch discards pending confirmations and late old response bodies", async () => {
  const held = deferred<unknown>(); fetcher.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? ({ ok: true, json: () => held.promise } as Response) : json(snapshot));
  const view = render(<DockTwitchAutomation token="old-token" />); await screen.findByText("Prediction · Open"); fireEvent.click(screen.getByRole("button", { name: "Cancel / refund" })); fireEvent.click(screen.getByRole("button", { name: "Request refund" })); await waitFor(() => expect(fetcher.mock.calls.some(call => call[1]?.method === "POST")).toBe(true));
  view.rerender(<DockTwitchAutomation token="new-token" />); await screen.findByText("Prediction · Open"); await act(async () => held.resolve({ current: { ...current, prediction: "canceled" } }));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.queryByText("Twitch confirmed cancellation and refunded the prediction.")).toBeNull(); expect(screen.getByText("Prediction · Open")).toBeTruthy();
});
it("a verified result is required before Resolve is offered and the server chooses its outcome", async () => {
  fetcher.mockResolvedValue(json({ ...snapshot, current: { ...current, canResolve: true } })); render(<DockTwitchAutomation token="owned" />); await screen.findByRole("button", { name: "Resolve verified result" });
  fireEvent.click(screen.getByRole("button", { name: "Resolve verified result" })); const dialog = screen.getByRole("dialog"); expect(within(dialog).queryByRole("combobox")).toBeNull(); fireEvent.click(within(dialog).getByRole("button", { name: "Resolve verified result" }));
  await waitFor(() => expect(fetcher.mock.calls.some(call => call[1]?.method === "POST")).toBe(true)); expect(JSON.parse(String(fetcher.mock.calls.find(call => call[1]?.method === "POST")?.[1]?.body))).not.toHaveProperty("outcome");
});
it("held response bodies time out so a retry is available", async () => {
  render(<DockTwitchAutomation token="owned" />); await screen.findByText("Prediction · Open"); vi.useFakeTimers(); fetcher.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? ({ ok: true, json: () => new Promise(() => {}) } as Response) : json(snapshot));
  fireEvent.click(screen.getByRole("button", { name: "Cancel / refund" })); fireEvent.click(screen.getByRole("button", { name: "Request refund" })); await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
  expect(screen.getByRole("alert").textContent).toContain("too long"); expect(screen.getByRole("button", { name: "Request refund" }).hasAttribute("disabled")).toBe(false);
});
it("a replaced token tells the parent to stop all old Dock controls", async () => {
  fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { code: "overlay_token_replaced" } }), { status: 401 })); const invalid = vi.fn(); render(<DockTwitchAutomation token="replaced" onInvalid={invalid} />); await waitFor(() => expect(invalid).toHaveBeenCalledWith(true));
});

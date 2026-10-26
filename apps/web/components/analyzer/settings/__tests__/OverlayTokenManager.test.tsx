import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverlayTokenManager } from "../OverlayTokenManager";

const dirty = vi.hoisted(() => ({ value: false, chat: false }));
vi.mock("../SettingsContext", () => ({ useSettingsContext: () => ({ isDirty: (id: string) => id === "chat" ? dirty.chat : dirty.value }) }));
const auth = vi.hoisted(() => ({ userId: "owner-a" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
const items = [{ token: "live-private", label: "Live", createdAt: "2026-10-25" }, { token: "test-private", label: "Test", createdAt: "2026-10-25" }];
const refresh = vi.fn(async () => undefined), select = vi.fn();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  dirty.value = dirty.chat = false; auth.userId = "owner-a"; auth.isLoaded = auth.isSignedIn = true; auth.getToken.mockReset().mockResolvedValue("synthetic-session");
  refresh.mockReset().mockResolvedValue(undefined); select.mockClear(); vi.stubGlobal("fetch", vi.fn(async () => json({})));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function manager(selected = items[0], pending = false) {
  return <OverlayTokenManager items={items} selected={{ ...selected, rotationPending: pending }} onSelect={select} onRefresh={refresh} />;
}

it("switches the displayed token and renames only the selected credential", async () => {
  const view = render(manager());
  fireEvent.change(screen.getByRole("combobox", { name: "URLs shown for" }), { target: { value: items[1].token } });
  expect(select).toHaveBeenCalledWith(items[1].token);
  view.rerender(manager(items[1]));
  fireEvent.change(screen.getByRole("textbox", { name: "Token label" }), { target: { value: "Tournament" } });
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  await screen.findByText("Token renamed.");
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/v1/overlay-tokens/test-private"), expect.objectContaining({ method: "PATCH", body: JSON.stringify({ label: "Tournament" }) }));
});

it("shows the preserve-data checklist, selects the result and continues pending work explicitly", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(json({ pending: false, token: "replacement-private" }));
  const view = render(manager());
  fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
  expect(screen.getByText(/Viewer XP, oracle scores, predictions and clip moments/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Rotate and preserve data" }));
  await waitFor(() => expect(select).toHaveBeenCalledWith("replacement-private"));
  await screen.findByText(/Overlay URL replaced\. Copy the new URLs/);
  view.rerender(manager(items[0], true));
  expect((screen.getByRole("button", { name: "Revoke" }) as HTMLButtonElement).disabled).toBe(true);
  vi.mocked(fetch).mockResolvedValueOnce(json({ pending: true }, 202));
  fireEvent.click(screen.getByRole("button", { name: "Continue rotation" }));
  await screen.findByText(/Rotation is paused safely/);
});

it("keeps Revoke a separate danger action with the viewer-XP warning", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
  render(manager()); fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  expect(screen.getByText(/Viewer XP and oracle scores stay with the revoked token/)).toBeTruthy();
  expect(document.activeElement?.textContent).toBe("Cancel");
  fireEvent.click(screen.getByRole("button", { name: "Revoke permanently" }));
  await screen.findByText(/Token revoked/);
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/v1/overlay-tokens/live-private"), expect.objectContaining({ method: "DELETE" }));
});

it("never sends a held prior-owner token lookup after an auth transition", async () => {
  let release!: (value: string) => void;
  auth.getToken.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  const view = render(manager()); fireEvent.click(screen.getByRole("button", { name: "Mint another token" }));
  auth.isLoaded = false; view.rerender(manager());
  await act(async () => { release("old-session"); });
  expect(fetch).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
});

it("settles a never-resolving authentication lookup with a retryable deadline", async () => {
  vi.useFakeTimers(); auth.getToken.mockImplementationOnce(() => new Promise(() => {}));
  render(manager()); fireEvent.click(screen.getByRole("button", { name: "Mint another token" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(15001); });
  expect(screen.getByRole("alert")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Mint another token" }) as HTMLButtonElement).disabled).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});


it("preserves unfinished Overlay drafts by blocking token changes until Save or Reset", () => {
  dirty.value = true; render(manager());
  expect((screen.getByRole("combobox", { name: "URLs shown for" }) as HTMLSelectElement).disabled).toBe(true);
  for (const name of ["Mint another token", "Rotate", "Revoke"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Save or reset your unsaved Overlay or Chat & alerts edits/)).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it("also guards Chat-only drafts, including a retained programmatic selection event", () => {
  const view = render(manager());
  dirty.chat = true; view.rerender(manager());
  const selector = screen.getByRole("combobox", { name: "URLs shown for" });
  expect(selector).toBeDisabled();
  fireEvent.change(selector, { target: { value: items[1].token } });
  expect(select).not.toHaveBeenCalled();
  for (const name of ["Mint another token", "Rotate", "Revoke"]) expect(screen.getByRole("button", { name })).toBeDisabled();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not publish a held mutation body after owner A→B→A", async () => {
  let release!: (value: unknown) => void;
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(resolve => { release = resolve; }) } as Response);
  const view = render(manager()); fireEvent.click(screen.getByRole("button", { name: "Mint another token" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  auth.userId = "owner-b"; view.rerender(manager()); auth.userId = "owner-a"; view.rerender(manager());
  await act(async () => release({ token: "retired-private" }));
  expect(select).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(screen.queryByText("Token created. Its URLs are now selected.")).toBeNull();
});

it("passes operation-specific revoke confirmation only after the real DELETE 204 ACK", async () => {
  const ambiguity = {}, dispatched = vi.fn(() => ambiguity);
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
  render(<OverlayTokenManager items={items} selected={items[0]} onSelect={select} onRefresh={refresh} onMutationDispatched={dispatched} />);
  fireEvent.click(screen.getByRole("button", { name: "Revoke", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke permanently" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledWith(undefined, true, { action: "revoke", predecessor: items[0].token, returnedToken: undefined, ambiguity }));
  expect(dispatched).toHaveBeenCalledWith(items[0].token);
});

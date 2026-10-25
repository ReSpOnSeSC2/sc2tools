import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverlayTokenManager } from "../OverlayTokenManager";

const dirty = vi.hoisted(() => ({ value: false }));
vi.mock("../SettingsContext", () => ({ useSettingsContext: () => ({ isDirty: () => dirty.value }) }));
const auth = vi.hoisted(() => ({ userId: "owner-a" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
const items = [{ token: "live-private", label: "Live", createdAt: "2026-10-25" }, { token: "test-private", label: "Test", createdAt: "2026-10-25" }];
const refresh = vi.fn(async () => undefined), select = vi.fn();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  dirty.value = false; auth.userId = "owner-a"; auth.isLoaded = auth.isSignedIn = true; auth.getToken.mockReset().mockResolvedValue("synthetic-session");
  refresh.mockClear(); select.mockClear(); vi.stubGlobal("fetch", vi.fn(async () => json({})));
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
  expect(screen.getByText(/Save or reset your unsaved Overlay edits/)).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

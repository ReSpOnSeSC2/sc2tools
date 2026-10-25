import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IdentityPlayer } from "../PlayerIdentityPicker";

const harness = vi.hoisted(() => ({
  userId: "owner-a" as string | null, isLoaded: true, isSignedIn: true,
  getToken: vi.fn(), useApi: vi.fn(), fetch: vi.fn(), mutateA: vi.fn(), mutateB: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({
  userId: harness.userId, isLoaded: harness.isLoaded, isSignedIn: harness.isSignedIn, getToken: harness.getToken,
}) }));
vi.mock("@/lib/clientApi", async (load) => ({
  ...await load<typeof import("@/lib/clientApi")>(),
  useApi: (...args: unknown[]) => harness.useApi(...args),
}));
vi.mock("../PlayerIdentityPicker", () => ({
  IdentityPlayerLabel: ({ player }: { player: IdentityPlayer }) => <span>{player.displayName}</span>,
  PlayerIdentityPicker: ({ value, onChange, disabled }: { value: IdentityPlayer | null; onChange: (value: IdentityPlayer) => void; disabled: boolean }) => <div>
    <button type="button" disabled={disabled} onClick={() => onChange({ key: "pulse:22", pulseId: "22", displayName: "Selected player" })}>Choose stable player</button>
    {value ? <span>{value.displayName}</span> : null}
  </div>,
}));

import { OpponentIdentitySubmission } from "../OpponentIdentitySubmission";

type Method = "POST" | "PUT" | "DELETE";
const PULSE = "1-S2-1-123";
const source = { key: "toon:1-S2-1-123", pulseId: PULSE, displayName: "Barcode" };
const target = { key: "pulse:22", pulseId: "22", displayName: "Confirmed player" };
const makeContext = (isAdmin = false, confirmed = false) => ({
  isAdmin, eligible: true, source, submission: null, replayCount: 2, revision: 7,
  confirmed: confirmed ? { groupKey: "known-player", displayName: "Confirmed player", target, revision: 7 } : null,
});
let contextA = makeContext();
let contextB = makeContext();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  harness.userId = "owner-a"; harness.isLoaded = true; harness.isSignedIn = true;
  contextA = makeContext(); contextB = makeContext();
  harness.getToken.mockReset().mockResolvedValue("token-a");
  harness.fetch.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => contextA });
  harness.mutateA.mockReset().mockResolvedValue(undefined); harness.mutateB.mockReset().mockResolvedValue(undefined);
  harness.useApi.mockReset().mockImplementation(() => ({
    data: harness.userId === "owner-a" ? contextA : contextB, isLoading: false,
    mutate: harness.userId === "owner-a" ? harness.mutateA : harness.mutateB,
  }));
  vi.stubGlobal("fetch", harness.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function openDraft(method: Method, onChanged = vi.fn()) {
  contextA = makeContext(method !== "POST", method === "DELETE");
  const view = render(<OpponentIdentitySubmission pulseId={PULSE} onChanged={onChanged} />);
  if (method === "DELETE") {
    fireEvent.click(screen.getByRole("button", { name: "Remove confirmed identity" }));
    fireEvent.change(screen.getByLabelText("Reason for removing the identity"), { target: { value: "Private account A removal evidence" } });
  } else {
    if (method === "POST") fireEvent.click(screen.getByRole("button", { name: "Know who this is? Suggest an identity" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose stable player" }));
    fireEvent.change(screen.getByLabelText("Why is this the same player?"), { target: { value: "Private account A replay evidence" } });
  }
  return { ...view, onChanged };
}
function submit(method: Method) {
  fireEvent.click(screen.getByRole("button", { name: method === "POST" ? "Submit for review" : method === "PUT" ? "Confirm identity" : "Remove identity" }));
}
function switchToB(view: ReturnType<typeof openDraft>) {
  harness.userId = "owner-b";
  view.rerender(<OpponentIdentitySubmission pulseId={PULSE} onChanged={view.onChanged} />);
}

it("withholds the editor and its lookup while authentication is loading or signed out", () => {
  harness.isLoaded = false;
  const view = render(<OpponentIdentitySubmission pulseId={PULSE} />);
  expect(screen.getByRole("status", { name: "Loading player identity" })).toBeTruthy();
  expect(harness.useApi).not.toHaveBeenCalled();
  harness.isLoaded = true; harness.isSignedIn = false; harness.userId = null;
  view.rerender(<OpponentIdentitySubmission pulseId={PULSE} />);
  expect(screen.queryByText("Player identity")).toBeNull();
  expect(harness.useApi).not.toHaveBeenCalled();
});

it("resets a private draft and its selected player even when both owners have warm lookup data", () => {
  const view = openDraft("POST");
  switchToB(view);
  expect(screen.queryByDisplayValue("Private account A replay evidence")).toBeNull();
  expect(screen.queryByText("Selected player")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Know who this is? Suggest an identity" }));
  expect(screen.getByLabelText("Why is this the same player?")).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: "Submit for review" })).toHaveProperty("disabled", true);
});

it.each(["POST", "PUT", "DELETE"] as Method[])("never sends an old %s draft when delayed token lookup returns the new owner's credentials", async (method) => {
  const token = deferred<string>(); harness.getToken.mockReturnValue(token.promise);
  const view = openDraft(method); submit(method);
  await waitFor(() => expect(harness.getToken).toHaveBeenCalledOnce());
  switchToB(view);
  await act(async () => { token.resolve("token-b"); await token.promise; });
  expect(harness.fetch).not.toHaveBeenCalled();
  expect(harness.mutateA).not.toHaveBeenCalled(); expect(harness.mutateB).not.toHaveBeenCalled();
  expect(view.onChanged).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["POST", "PUT", "DELETE"] as Method[])("aborts an in-flight %s and ignores a late response after switching owners", async (method) => {
  const responseBody = deferred<ReturnType<typeof makeContext>>();
  harness.fetch.mockResolvedValue({ ok: true, status: 200, json: () => responseBody.promise });
  const view = openDraft(method); submit(method);
  await waitFor(() => expect(harness.fetch).toHaveBeenCalledOnce());
  const init = harness.fetch.mock.calls[0][1] as RequestInit;
  expect(init.method).toBe(method);
  expect(init.headers).toMatchObject({ authorization: "Bearer token-a" });
  switchToB(view);
  expect(init.signal?.aborted).toBe(true);
  await act(async () => { responseBody.resolve(contextA); await responseBody.promise; });
  expect(harness.mutateA).not.toHaveBeenCalled(); expect(harness.mutateB).not.toHaveBeenCalled();
  expect(view.onChanged).not.toHaveBeenCalled();
  expect(screen.queryByText(/Identity confirmed for everyone|Identity submitted for admin review|Confirmed identity removed/)).toBeNull();
});

it("does not run a late shared refresh callback when the owner changes during cache mutation", async () => {
  const mutation = deferred<void>(); harness.mutateA.mockReturnValue(mutation.promise);
  const view = openDraft("PUT"); submit("PUT");
  await waitFor(() => expect(harness.mutateA).toHaveBeenCalledOnce());
  switchToB(view);
  await act(async () => { mutation.resolve(); await mutation.promise; });
  expect(view.onChanged).not.toHaveBeenCalled();
  expect(harness.mutateB).not.toHaveBeenCalled();
  expect(screen.queryByText("Identity confirmed for everyone.")).toBeNull();
});

it.each(["signed-out", "loading", "unmounted"])("cancels pending credentials when %s", async (state) => {
  const token = deferred<string>(); harness.getToken.mockReturnValue(token.promise);
  const view = openDraft("POST"); submit("POST");
  if (state === "unmounted") view.unmount();
  else {
    if (state === "signed-out") { harness.isSignedIn = false; harness.userId = null; }
    else harness.isLoaded = false;
    view.rerender(<OpponentIdentitySubmission pulseId={PULSE} />);
  }
  await act(async () => { token.resolve("late-token"); await token.promise; });
  expect(harness.fetch).not.toHaveBeenCalled();
  expect(harness.mutateA).not.toHaveBeenCalled();
});

it("keeps same-owner confirmations working with the guarded credentials and revision", async () => {
  const view = openDraft("PUT"); submit("PUT");
  await waitFor(() => expect(view.onChanged).toHaveBeenCalledOnce());
  expect(harness.fetch).toHaveBeenCalledOnce();
  const [url, init] = harness.fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toContain(`/opponents/${PULSE}/confirmed-identity`);
  expect(JSON.parse(String(init.body))).toMatchObject({ targetKey: "pulse:22", reason: "Private account A replay evidence", revision: 7 });
  expect(screen.getByText("Identity confirmed for everyone.")).toBeTruthy();
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

const mocks = vi.hoisted(() => ({ owner: "a", token: vi.fn<() => Promise<string | null>>(), call: vi.fn(), mutate: vi.fn(), cacheMutate: vi.fn(), success: vi.fn(), error: vi.fn(), writes: [] as { token: string | null; body: Record<string, unknown> }[], body: null as Promise<unknown> | null }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: mocks.owner, isLoaded: true, isSignedIn: true, getToken: mocks.token }) }));
vi.mock("@/lib/clientApi", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/clientApi")>(),
  apiCall: mocks.call,
  useApi: () => ({ data: { battleTag: "Owner#1234", pulseIds: [], sessionGapMinutes: null, sessionPolicy: { gapMinutes: 90, source: "auto-player", storedGapMinutes: null } }, isLoading: false, mutate: mocks.mutate }),
}));
vi.mock("swr", async importOriginal => {
  const actual = await importOriginal<typeof import("swr")>();
  return { ...actual, useSWRConfig: () => ({ ...actual.useSWRConfig(), mutate: mocks.cacheMutate }) };
});
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: { success: mocks.success, error: mocks.error } }) }));
vi.mock("../SettingsPlayerChannels", () => ({ SettingsPlayerChannels: () => null }));
vi.mock("../SettingsPublicProfile", () => ({ SettingsPublicProfile: () => null }));
import { SettingsProfile } from "../SettingsProfile";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function View() { return <SWRConfig value={{ provider: () => new Map() }}><SettingsProfile /></SWRConfig>; }
function edit(value: string) { fireEvent.change(screen.getByPlaceholderText("Auto"), { target: { value } }); fireEvent.click(screen.getByRole("button", { name: "Save changes" })); }
beforeEach(() => {
  mocks.owner = "a"; mocks.writes = []; mocks.body = null;
  mocks.token.mockReset().mockImplementation(async () => `token-${mocks.owner}`);
  mocks.mutate.mockReset().mockResolvedValue(undefined); mocks.cacheMutate.mockReset().mockResolvedValue(undefined); mocks.success.mockClear(); mocks.error.mockClear();
  mocks.call.mockReset().mockImplementation(async (getToken: () => Promise<string | null>, _path: string, init: RequestInit) => {
    const token = await getToken(), body = JSON.parse(String(init.body)); mocks.writes.push({ token, body });
    if (mocks.body) await mocks.body;
    return { ...body, sessionPolicy: { gapMinutes: body.sessionGapMinutes ?? 90, source: body.sessionGapMinutes == null ? "auto-player" : "preference", storedGapMinutes: body.sessionGapMinutes } };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("saves an integer preference and preserves the normal dirty/Save flow", async () => {
  render(<View />); edit("15");
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Profile saved"));
  expect(mocks.writes).toHaveLength(1); expect(mocks.writes[0]).toMatchObject({ token: "token-a", body: { sessionGapMinutes: 15 } });
  expect(mocks.mutate).toHaveBeenCalledOnce();
  expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ sessionGapMinutes: 15, sessionPolicy: { gapMinutes: 15, source: "preference", storedGapMinutes: 15 } }), { revalidate: false });
  expect(mocks.error).not.toHaveBeenCalled();
});
it("rejects a fractional draft before any write or optimistic mutation", () => {
  render(<View />); edit("15.5");
  expect(mocks.token).not.toHaveBeenCalled(); expect(mocks.writes).toEqual([]); expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.error).toHaveBeenCalledOnce();
});
it("held JWT across A->B->A cannot issue a retired policy write with the same token callback", async () => {
  const held = deferred<string | null>(); mocks.token.mockImplementationOnce(() => held.promise);
  const view = render(<View />); edit("45"); await waitFor(() => expect(mocks.token).toHaveBeenCalledOnce());
  expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.cacheMutate).not.toHaveBeenCalled();
  mocks.owner = "b"; view.rerender(<View />); mocks.owner = "a"; view.rerender(<View />);
  expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.cacheMutate).not.toHaveBeenCalled();
  await act(async () => { held.resolve("old-a-token"); await Promise.resolve(); });
  expect(mocks.writes).toEqual([]); expect(mocks.mutate).not.toHaveBeenCalled(); expect(mocks.cacheMutate).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
});
it("held response body after unmount cannot mutate, mark saved or toast", async () => {
  const held = deferred<void>(); mocks.body = held.promise;
  const view = render(<View />); edit("45"); await waitFor(() => expect(mocks.writes).toHaveLength(1));
  const mutations = mocks.mutate.mock.calls.length; view.unmount();
  await act(async () => { held.resolve(); await Promise.resolve(); });
  expect(mocks.mutate).toHaveBeenCalledTimes(mutations); expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
});

it("publishes only the admitted owner's tiny policy ACK without a second GET", async () => {
  render(<View />); edit("45");
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Profile saved"));
  expect(mocks.cacheMutate).toHaveBeenCalledOnce();
  const [select, policy, options] = mocks.cacheMutate.mock.calls[0];
  expect(select(["authenticated-api", "a", "/v1/me/session-policy"])).toBe(true);
  expect(select(["authenticated-api", "b", "/v1/me/session-policy"])).toBe(false);
  expect(select(["authenticated-api", "a", "/v1/me/profile"])).toBe(false);
  expect(policy).toEqual({ gapMinutes: 45, source: "preference", storedGapMinutes: 45 });
  expect(options).toEqual({ revalidate: false });
  expect(mocks.call.mock.calls.map(call => call[1])).toEqual(["/v1/me/profile"]);
});

it("does not report a confirmed PUT as failed when local policy cache publication rejects", async () => {
  mocks.cacheMutate.mockRejectedValueOnce(new Error("synthetic local cache failure"));
  render(<View />); edit("45");
  await waitFor(() => expect(mocks.success).toHaveBeenCalledWith("Profile saved"));
  expect(mocks.writes).toHaveLength(1); expect(mocks.error).not.toHaveBeenCalled();
  expect(mocks.mutate.mock.calls).toHaveLength(1);
  expect(mocks.mutate.mock.calls[0][0]).toMatchObject({ sessionGapMinutes: 45 });
});

it("clearing the input explicitly saves Auto rather than losing the field in a legacy patch", async () => {
  render(<View />); edit("45");
  await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
  edit(""); await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(2));
  expect(mocks.writes.map(row => row.body.sessionGapMinutes)).toEqual([45, null]);
  expect(mocks.cacheMutate.mock.calls[1][1]).toEqual({ gapMinutes: 90, source: "auto-player", storedGapMinutes: null });
});

it("held response body across A->B->A cannot publish cache, dirty state or a toast", async () => {
  const held = deferred<void>(); mocks.body = held.promise;
  const view = render(<View />); edit("45"); await waitFor(() => expect(mocks.writes).toHaveLength(1));
  const before = mocks.mutate.mock.calls.length;
  mocks.owner = "b"; view.rerender(<View />); mocks.owner = "a"; view.rerender(<View />);
  await act(async () => { held.resolve(); await Promise.resolve(); });
  expect(mocks.mutate).toHaveBeenCalledTimes(before); expect(mocks.cacheMutate).not.toHaveBeenCalled();
  expect(mocks.success).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
});

it("a held JWT reaches its deadline, leaves a retryable draft, and cannot dispatch later", async () => {
  vi.useFakeTimers(); const held = deferred<string | null>(); mocks.token.mockReturnValueOnce(held.promise);
  render(<View />); edit("45");
  await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
  expect(mocks.error).toHaveBeenCalledWith("Couldn't save profile", expect.any(Object));
  expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(false);
  const before = mocks.mutate.mock.calls.length;
  await act(async () => { held.resolve("late-a-token"); await Promise.resolve(); });
  expect(mocks.writes).toEqual([]); expect(mocks.mutate).toHaveBeenCalledTimes(before);
  expect(mocks.cacheMutate).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled();
});

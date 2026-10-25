import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ owner: "owner-a", loaded: true, signedIn: true, getToken: vi.fn(), response: vi.fn(), sent: [] as unknown[], devices: [] as { id: string; label: string; supported: boolean; enabled: boolean }[] }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: state.owner, isLoaded: state.loaded, isSignedIn: state.signedIn, getToken: state.getToken }) }));
vi.mock("@/lib/clientApi", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/clientApi")>();
  return { ...original, useApi: () => ({ data: { devices: state.devices }, mutate: vi.fn(), isPreviousData: false }), apiCall: async (getToken: () => Promise<unknown>, path: string, options: RequestInit) => {
    await getToken(); state.sent.push({ path, body: JSON.parse(String(options.body)) }); return state.response();
  } };
});
import { useObsAddSource } from "../useObsAddSource";
const device = { id: "a".repeat(24), label: "Local agent", supported: true, enabled: true };
beforeEach(() => { state.owner = "owner-a"; state.loaded = state.signedIn = true; state.devices = [device]; state.sent = []; state.getToken.mockReset().mockResolvedValue("synthetic-auth"); state.response.mockReset().mockResolvedValue({ code: "added" }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("disables an offline or default-off agent without dispatching", async () => {
  state.devices = []; const view = renderHook(useObsAddSource);
  expect(view.result.current.reason).toContain("Open your paired"); await act(() => view.result.current.add("opponent")); expect(state.sent).toEqual([]);
  state.devices = [{ ...device, enabled: false }]; view.rerender(); expect(view.result.current.reason).toContain("Enable website");
});
it("sends one allowlisted widget/device request and renders the local acknowledgement", async () => {
  const { result } = renderHook(useObsAddSource); await act(() => result.current.add("opponent"));
  expect(state.sent).toEqual([{ path: "/v1/devices/obs/add-source", body: { widget: "opponent", deviceId: device.id } }]);
  expect(result.current.message).toContain("Source added"); expect(result.current.busy).toBeNull();
});
it("requires explicit device choice when two consenting devices are online", async () => {
  state.devices = [device, { ...device, id: "b".repeat(24) }]; const { result } = renderHook(useObsAddSource);
  expect(result.current.reason).toContain("Choose a desktop"); await act(() => result.current.add("opponent")); expect(state.sent).toEqual([]);
  act(() => result.current.setDeviceId(state.devices[1].id)); await act(() => result.current.add("opponent")); expect((state.sent[0] as { body: { deviceId: string } }).body.deviceId).toBe(state.devices[1].id);
});
it("keeps Cancel/scene-change outcomes visible and never retries automatically", async () => {
  state.response.mockResolvedValue({ code: "declined" }); const { result } = renderHook(useObsAddSource);
  await act(() => result.current.add("opponent")); expect(result.current.message).toContain("No source was added"); expect(state.sent).toHaveLength(1);
  state.response.mockResolvedValue({ code: "scene_changed" }); await act(() => result.current.add("opponent")); expect(result.current.message).toContain("scene changed"); expect(state.sent).toHaveLength(2);
});
it.each(["loading", "signed-out", "other-owner"])("withholds state and rejects a late token across %s", async boundary => {
  let release!: (value: string) => void; state.getToken.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  const view = renderHook(useObsAddSource); act(() => { void view.result.current.add("opponent"); });
  if (boundary === "loading") state.loaded = false; else if (boundary === "signed-out") state.signedIn = false; else state.owner = "owner-b";
  view.rerender(); expect(view.result.current.message).toBe(""); expect(view.result.current.busy).toBeNull();
  await act(async () => release("late-A-token")); expect(state.sent).toEqual([]);
});
it("does not let an old A response overwrite a new A request after A-B-A", async () => {
  let releaseOld!: (value: unknown) => void, releaseNew!: (value: unknown) => void;
  state.response.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; })).mockImplementationOnce(() => new Promise(resolve => { releaseNew = resolve; }));
  const view = renderHook(useObsAddSource); act(() => { void view.result.current.add("opponent"); }); await waitFor(() => expect(state.sent).toHaveLength(1));
  state.owner = "owner-b"; view.rerender(); state.owner = "owner-a"; view.rerender();
  act(() => { void view.result.current.add("session"); }); await waitFor(() => expect(state.sent).toHaveLength(2));
  await act(async () => releaseOld({ code: "added" })); expect(view.result.current.busy).toBe("session"); expect(view.result.current.message).toContain("Confirm Add source");
  await act(async () => releaseNew({ code: "declined" })); expect(view.result.current.message).toContain("Cancelled");
});
it.each(["token", "body"])("a real deadline settles a held %s and permits a fresh attempt", async stage => {
  vi.useFakeTimers(); let release!: (value: never) => void;
  const held = () => new Promise<never>(resolve => { release = resolve; });
  if (stage === "token") state.getToken.mockImplementationOnce(held); else state.response.mockImplementationOnce(held);
  const { result } = renderHook(useObsAddSource); act(() => { void result.current.add("opponent"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(50001); });
  expect(result.current.busy).toBeNull(); expect(result.current.message).toContain("Inspect OBS");
  await act(() => result.current.add("session")); expect(result.current.message).toContain("Source added");
  await act(async () => release("late" as never)); expect(result.current.message).toContain("Source added");
});

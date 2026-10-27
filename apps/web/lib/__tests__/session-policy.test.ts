import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { SWRConfig, unstable_serialize, useSWRConfig } from "swr";
import { readSessionPolicy, useSessionPolicy, SESSION_POLICY_PATH } from "../session-policy";
const auth = vi.hoisted(() => ({ owner: "owner-a" as string | null, loaded: true, getToken: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: auth.owner, isLoaded: auth.loaded, isSignedIn: !!auth.owner, getToken: auth.getToken }) }));
it.each([
  { gapMinutes: 15, source: "preference", storedGapMinutes: 15 },
  { gapMinutes: 480, source: "preference", storedGapMinutes: 480 },
  { gapMinutes: 240, source: "auto-overlay", storedGapMinutes: null },
  { gapMinutes: 90, source: "auto-player", storedGapMinutes: null },
])("accepts exact tiny policy DTO%j", value => { expect(readSessionPolicy(value)).toEqual(value); });
it.each([null, {}, { gapMinutes: 90 }, { gapMinutes: "90", source: "auto-player", storedGapMinutes: null },
  { gapMinutes: 240, source: "auto-player", storedGapMinutes: null },
  { gapMinutes: 15, source: "preference", storedGapMinutes: 90 },
  { gapMinutes: 15.5, source: "preference", storedGapMinutes: 15.5 },
  { gapMinutes: 90, source: "auto-player", storedGapMinutes: null, userId: "not-public" },
])("rejects malformed/unknown policy instead of inventing Auto%j", value => { expect(readSessionPolicy(value)).toBeNull(); });

const player = { gapMinutes: 90, source: "auto-player", storedGapMinutes: null };
const overlay = { gapMinutes: 240, source: "auto-overlay", storedGapMinutes: null };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
let cache: Map<string, { data?: unknown; isLoading?: boolean; isValidating?: boolean }>;
let restoreAnimationFrame: (() => void) | undefined;
let reads: { path: string; authorization: string }[];
let transport: (owner: string) => Promise<Response>;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(SWRConfig, { value: { provider: () => cache, revalidateOnFocus: false, revalidateOnReconnect: false } }, children);
}
beforeEach(() => {
  auth.owner = "owner-a"; auth.loaded = true; auth.getToken.mockReset().mockImplementation(async () => `jwt-${auth.owner}`);
  cache = new Map(); reads = []; transport = async owner => reply(owner === "owner-b" ? overlay : player);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    if (path !== SESSION_POLICY_PATH || (init.method ?? "GET") !== "GET") throw new Error(`Unexpected policy transport ${path}`);
    const authorization = String((init.headers as Record<string, string>)?.authorization ?? "");
    reads.push({ path, authorization }); return transport(authorization.replace("Bearer jwt-", ""));
  }));
});
afterEach(() => { cleanup(); restoreAnimationFrame?.(); restoreAnimationFrame = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

it("shares one tiny owner request across logical consumers without loading Profile", async () => {
  const view = renderHook(() => [useSessionPolicy(), useSessionPolicy()], { wrapper });
  await waitFor(() => expect(view.result.current[0].policy).toEqual(player));
  expect(view.result.current[1].policy).toEqual(player); expect(reads).toEqual([{ path: SESSION_POLICY_PATH, authorization: "Bearer jwt-owner-a" }]);
});
it("does not admit a warm policy after its explicit refresh fails", async () => {
  const view = renderHook(() => useSessionPolicy(), { wrapper });
  await waitFor(() => expect(view.result.current.policy).toEqual(player));
  transport = async () => reply({ error: { code: "policy_unavailable" } }, 503);
  await act(async () => { await view.result.current.retry().catch(() => {}); });
  expect(view.result.current.policy).toBeNull(); expect(view.result.current.error).toBeTruthy(); expect(reads).toHaveLength(2);
});
it("keeps malformed policy unavailable until a narrow successful retry", async () => {
  transport = vi.fn().mockResolvedValueOnce(reply({ ...overlay, source: "auto-player" })).mockResolvedValueOnce(reply(player));
  const view = renderHook(() => useSessionPolicy(), { wrapper });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.policy).toBeNull(); expect(view.result.current.error).toBeTruthy();
  await act(async () => { await view.result.current.retry(); });
  await waitFor(() => expect(view.result.current.policy).toEqual(player)); expect(reads).toHaveLength(2);
});
it("retires a held JWT across owner A->B->A before any retired-token GET", async () => {
  const held = deferred<string>(); auth.getToken.mockImplementationOnce(() => held.promise);
  const view = renderHook(() => useSessionPolicy(), { wrapper });
  await waitFor(() => expect(auth.getToken).toHaveBeenCalledOnce());
  auth.owner = "owner-b"; view.rerender(); await waitFor(() => expect(view.result.current.policy).toEqual(overlay));
  auth.owner = "owner-a"; view.rerender(); await act(async () => { held.resolve("retired-token-a"); await Promise.resolve(); });
  expect(reads.some(row => row.authorization === "Bearer retired-token-a")).toBe(false);
  expect(cache.get(unstable_serialize(["authenticated-api", "owner-b", SESSION_POLICY_PATH]))?.data).toEqual(overlay);
});
it("retires a held response body across owner A->B->A before cache publication", async () => {
  const held = deferred<unknown>();
  transport = vi.fn().mockImplementationOnce(async () => ({ ok: true, status: 200, json: () => held.promise }) as Response)
    .mockImplementation(async (owner: string) => reply(owner === "owner-b" ? overlay : player));
  const view = renderHook(() => useSessionPolicy(), { wrapper }); await waitFor(() => expect(reads).toHaveLength(1));
  auth.owner = "owner-b"; view.rerender(); await waitFor(() => expect(view.result.current.policy).toEqual(overlay));
  auth.owner = "owner-a"; view.rerender();
  const retired = { gapMinutes: 15, source: "preference", storedGapMinutes: 15 };
  await act(async () => { held.resolve(retired); await Promise.resolve(); });
  expect(cache.get(unstable_serialize(["authenticated-api", "owner-a", SESSION_POLICY_PATH]))?.data).not.toEqual(retired);
  expect(cache.get(unstable_serialize(["authenticated-api", "owner-b", SESSION_POLICY_PATH]))?.data).toEqual(overlay);
});
it("waits while auth is loading or signed out and never guesses the player default", async () => {
  auth.loaded = false; const view = renderHook(() => useSessionPolicy(), { wrapper });
  await act(async () => {}); expect(reads).toEqual([]); expect(view.result.current.policy).toBeNull();
  auth.loaded = true; auth.owner = null; view.rerender(); await act(async () => {});
  expect(reads).toEqual([]); expect(view.result.current.policy).toBeNull();
});
it("bounds a held body and cannot publish it after the deadline", async () => {
  vi.useFakeTimers(); const held = deferred<unknown>();
  transport = async () => ({ ok: true, status: 200, json: () => held.promise }) as Response;
  const view = renderHook(() => useSessionPolicy(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
  expect(view.result.current.policy).toBeNull(); expect(view.result.current.error).toBeTruthy();
  await act(async () => { held.resolve(player); await Promise.resolve(); });
  expect(cache.get(unstable_serialize(["authenticated-api", "owner-a", SESSION_POLICY_PATH]))?.data).toBeUndefined();
});

it("waits for current policy admission instead of generating from a warm value during revalidation", async () => {
  const held = deferred<unknown>();
  const key = unstable_serialize(["authenticated-api", "owner-a", SESSION_POLICY_PATH]);
  cache.set(key, { data: player, isLoading: false, isValidating: false });
  transport = async () => ({ ok: true, status: 200, json: () => held.promise }) as Response;
  const view = renderHook(() => useSessionPolicy(), { wrapper });
  await waitFor(() => expect(reads).toHaveLength(1));
  expect(view.result.current.policy).toBeNull(); expect(view.result.current.loading).toBe(true);
  await act(async () => { held.resolve(overlay); await Promise.resolve(); });
  await waitFor(() => expect(view.result.current.policy).toEqual(overlay));
  expect(view.result.current.loading).toBe(false); expect(reads).toHaveLength(1);
});

function holdPolicyFrames() {
  const frames: FrameRequestCallback[] = [];
  const original = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, writable: true,
    value: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; } });
  restoreAnimationFrame = () => {
    if (original) Object.defineProperty(window, "requestAnimationFrame", original);
    else Reflect.deleteProperty(window, "requestAnimationFrame");
  };
  return frames;
}

it("blocks settled warm flags on the first render, then admits identical fresh JSON with one shared GET", async () => {
  const frames = holdPolicyFrames();
  const key = unstable_serialize(["authenticated-api", "owner-a", SESSION_POLICY_PATH]);
  const warm = { ...player };
  cache.set(key, { data: warm, isLoading: false, isValidating: false });
  const held = deferred<unknown>();
  transport = async () => ({ ok: true, status: 200, json: () => held.promise }) as Response;
  const view = renderHook(() => [useSessionPolicy(), useSessionPolicy()], { wrapper });
  // Assert before either scheduled revalidation starts; a real settled cache
  // entry contains false flags, unlike a data-only fallback fixture.
  expect(reads).toEqual([]); expect(frames).toHaveLength(2);
  expect(view.result.current.map(value => value.policy)).toEqual([null, null]);
  expect(view.result.current.every(value => value.loading)).toBe(true);
  await act(async () => { for (const callback of frames.splice(0)) callback(0); await Promise.resolve(); });
  await waitFor(() => expect(reads).toHaveLength(1));
  expect(view.result.current.map(value => value.policy)).toEqual([null, null]);
  const current = { ...player };
  await act(async () => { held.resolve(current); await Promise.resolve(); });
  await waitFor(() => expect(view.result.current.every(value => value.policy === current)).toBe(true));
  expect(current).not.toBe(warm); expect(current).toEqual(warm);
  expect(reads).toEqual([{ path: SESSION_POLICY_PATH, authorization: "Bearer jwt-owner-a" }]);
});

it("admits a newly published Profile ACK without another HTTP read", async () => {
  const frames = holdPolicyFrames();
  const key = unstable_serialize(["authenticated-api", "owner-a", SESSION_POLICY_PATH]);
  cache.set(key, { data: player, isLoading: false, isValidating: false });
  const view = renderHook(() => ({ session: useSessionPolicy(), publish: useSWRConfig().mutate }), { wrapper });
  expect(frames).toHaveLength(1); expect(reads).toEqual([]); expect(view.result.current.session.policy).toBeNull();
  await act(async () => { await view.result.current.publish(["authenticated-api", "owner-a", SESSION_POLICY_PATH], overlay, { revalidate: false }); });
  await waitFor(() => expect(view.result.current.session.policy).toBe(overlay));
  expect(view.result.current.session.loading).toBe(false); expect(reads).toEqual([]);
});
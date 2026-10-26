import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queuePendingIntent } from "../pendingIntent";
import { usePendingIntentResume } from "../usePendingIntentResume";
const event = vi.hoisted(() => vi.fn());
const fixture = vi.hoisted(() => ({ auth: { userId: "A", isLoaded: true, isSignedIn: true, getToken: vi.fn(async () => "jwt-A") } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => fixture.auth }));
vi.mock("../analytics/gtag", () => ({ gaEvent: event }));
const path = "/community/builds/build-one";
beforeEach(() => { sessionStorage.clear(); event.mockClear(); fixture.auth = { userId: "A", isLoaded: true, isSignedIn: true, getToken: vi.fn(async () => "jwt-A") }; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("completes one explicit matching action under StrictMode without a duplicate claim", async () => {
  queuePendingIntent("vote", { slug: "build-one", delta: 1 }, path);
  const resume = vi.fn(async () => true);
  const { result } = renderHook(() => usePendingIntentResume("vote", path, true, payload => payload.slug === "build-one", resume), { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
  await waitFor(() => expect(result.current.completed).toBe(true));
  expect(resume).toHaveBeenCalledTimes(1); expect(event).toHaveBeenCalledWith("auth_intent_completed", { kind: "vote" });
});

it("a nonmatching responsive instance leaves the intent for the correct build", async () => {
  queuePendingIntent("vote", { slug: "build-one", delta: -1 }, path);
  const wrong = vi.fn(async () => true), right = vi.fn(async () => true);
  renderHook(() => usePendingIntentResume("vote", path, true, payload => payload.slug === "another", wrong));
  const { result } = renderHook(() => usePendingIntentResume("vote", path, true, payload => payload.slug === "build-one", right));
  await waitFor(() => expect(result.current.completed).toBe(true));
  expect(wrong).not.toHaveBeenCalled(); expect(right).toHaveBeenCalledTimes(1);
});

it("a held JWT cannot post through an A to B to A account switch", async () => {
  queuePendingIntent("vote", { slug: "build-one", delta: 1 }, path);
  let release!: (token: string) => void;
  fixture.auth.getToken.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const post = vi.fn();
  const { result, rerender } = renderHook(() => usePendingIntentResume("vote", path, true, () => true, async (_intent, context) => { await context.getToken(); post(); return true; }));
  await waitFor(() => expect(fixture.auth.getToken).toHaveBeenCalled());
  fixture.auth = { ...fixture.auth, userId: "B" }; rerender();
  fixture.auth = { ...fixture.auth, userId: "A" }; rerender();
  await act(async () => { release("jwt-A"); await Promise.resolve(); });
  expect(post).not.toHaveBeenCalled(); expect(result.current.completed).toBe(false); expect(result.current.running).toBe(false);
  expect(event.mock.calls.filter(([name]) => name === "auth_intent_completed")).toHaveLength(0);
});

it("a held response cannot report completion after unmount or a different destination", async () => {
  queuePendingIntent("save-build", { slug: "build-one" }, path);
  let release!: (done: boolean) => void;
  const resume = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
  const { unmount } = renderHook(() => usePendingIntentResume("save-build", path, true, () => true, resume));
  await waitFor(() => expect(resume).toHaveBeenCalled()); unmount();
  await act(async () => { release(true); await Promise.resolve(); });
  expect(event.mock.calls.filter(([name]) => name === "auth_intent_completed")).toHaveLength(0);
});

it("bounds a stalled original action and exposes a normal manual retry message", async () => {
  vi.useFakeTimers(); queuePendingIntent("vote", { slug: "build-one", delta: 1 }, path);
  let signal: AbortSignal | null = null;
  let release!: () => void; const lateEffect = vi.fn();
  const { result } = renderHook(() => usePendingIntentResume("vote", path, true, () => true, async (_intent, context) => {
    signal = context.signal; await new Promise<void>(resolve => { release = resolve; });
    if (context.isCurrent()) lateEffect(); return true;
  }));
  await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(20_001); });
  expect(result.current.error).toContain("try again"); expect(result.current.running).toBe(false); expect(signal).toHaveProperty("aborted", true);
  await act(async () => { release(); await Promise.resolve(); });
  expect(lateEffect).not.toHaveBeenCalled(); expect(result.current.completed).toBe(false);
});

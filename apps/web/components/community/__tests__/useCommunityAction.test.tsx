import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCommunityAction } from "../useCommunityAction";
import type { IntentResumeContext } from "@/lib/usePendingIntentResume";

const fixture = vi.hoisted(() => ({ auth: {
  userId: "A", isLoaded: true, isSignedIn: true, getToken: vi.fn(async () => "jwt-A"),
} }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => fixture.auth }));

beforeEach(() => {
  fixture.auth = { userId: "A", isLoaded: true, isSignedIn: true, getToken: vi.fn(async () => "jwt-A") };
});
afterEach(cleanup);
const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

it.each([false, true])("rejects a retained action before token/operation admission after account A→B (ABA %s)", async aba => {
  const { result, rerender } = renderHook(() => useCommunityAction("build-one"), { wrapper: strict });
  const oldRun = result.current.run;
  const operation = vi.fn(async (context: IntentResumeContext) => { await context.getToken(); return "old mutation"; }), onError = vi.fn();
  const oldToken = fixture.auth.getToken;
  fixture.auth = { ...fixture.auth, userId: "B", getToken: vi.fn(async () => "jwt-B") }; rerender();
  if (aba) { fixture.auth = { ...fixture.auth, userId: "A", getToken: vi.fn(async () => "jwt-new-A") }; rerender(); }
  await expect(oldRun(operation, onError)).rejects.toMatchObject({ name: "AbortError" });
  expect(operation).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
  expect(oldToken).not.toHaveBeenCalled(); expect(fixture.auth.getToken).not.toHaveBeenCalled();
  expect(result.current.running).toBe(false);
  await act(async () => { expect(await result.current.run(async context => context.getToken(), onError))
    .toBe(aba ? "jwt-new-A" : "jwt-B"); });
});

it.each([false, true])("rejects a retained action after record one→two (ABA %s)", async aba => {
  const { result, rerender } = renderHook(({ record }) => useCommunityAction(record), { initialProps: { record: "one" }, wrapper: strict });
  const oldRun = result.current.run, operation = vi.fn(async () => "old record"), onError = vi.fn();
  rerender({ record: "two" }); if (aba) rerender({ record: "one" });
  await expect(oldRun(operation, onError)).rejects.toMatchObject({ name: "AbortError" });
  expect(operation).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
  expect(result.current.running).toBe(false);
});

it("rejects a retained action after unmount without invoking even a token-free operation", async () => {
  const { result, unmount } = renderHook(() => useCommunityAction("one"), { wrapper: strict });
  const run = result.current.run, operation = vi.fn(async () => "would mutate"), onError = vi.fn();
  unmount(); await expect(run(operation, onError)).rejects.toMatchObject({ name: "AbortError" });
  expect(operation).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled(); expect(fixture.auth.getToken).not.toHaveBeenCalled();
});

it("does not let a stale callback take the busy slot or cancel a current operation", async () => {
  const { result, rerender } = renderHook(() => useCommunityAction("one"), { wrapper: strict });
  const oldRun = result.current.run;
  fixture.auth = { ...fixture.auth, userId: "B" }; rerender();
  let release!: () => void; let signal: AbortSignal | undefined;
  let current!: Promise<string>;
  await act(async () => { current = result.current.run(async context => {
    signal = context.signal; await new Promise<void>(resolve => { release = resolve; }); return "current result";
  }, vi.fn()); await Promise.resolve(); });
  expect(result.current.running).toBe(true);
  const stale = vi.fn(async () => "old result");
  await expect(oldRun(stale, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
  expect(stale).not.toHaveBeenCalled(); expect(signal?.aborted).toBe(false);
  await act(async () => { release(); expect(await current).toBe("current result"); });
  expect(result.current.running).toBe(false);
});

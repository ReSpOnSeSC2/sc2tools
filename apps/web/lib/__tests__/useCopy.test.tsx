import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCopy } from "../useCopy";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("never copies on mount, and returns success only after an explicit clipboard write", async () => {
  const writeText = vi.fn(async () => undefined), copied = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { result } = renderHook(() => useCopy({ onCopied: copied }), {
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  });
  expect(writeText).not.toHaveBeenCalled();
  expect(result.current.status).toBe("idle");
  let success = false;
  await act(async () => { success = await result.current.copy("Exact text"); });
  expect(success).toBe(true);
  expect(writeText).toHaveBeenCalledOnce(); expect(writeText).toHaveBeenCalledWith("Exact text");
  expect(result.current.copied).toBe(true);
  expect(result.current.fallbackText).toBeNull();
  expect(copied).toHaveBeenCalledOnce();
});

it.each(["missing", "rejects", "throws"])("offers exact manual text when the clipboard %s", async mode => {
  const writeText = vi.fn(() => {
    if (mode === "throws") throw new Error("Permission denied");
    return Promise.reject(new Error("Permission denied"));
  });
  vi.stubGlobal("navigator", mode === "missing" ? {} : { clipboard: { writeText } });
  const fallback = vi.fn(), copied = vi.fn();
  const { result } = renderHook(() => useCopy({ onFallback: fallback, onCopied: copied }));
  let success = true;
  await act(async () => { success = await result.current.copy("  Keep whitespace\nand lines  "); });
  expect(success).toBe(false);
  expect(result.current.status).toBe("fallback");
  expect(result.current.fallbackText).toBe("  Keep whitespace\nand lines  ");
  expect(fallback).toHaveBeenCalledOnce(); expect(copied).not.toHaveBeenCalled();
});

it("settles a held clipboard permission request into manual fallback after five seconds", async () => {
  vi.useFakeTimers();
  const held = deferred(), copied = vi.fn(), fallback = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText: () => held.promise } });
  const { result } = renderHook(() => useCopy({ onCopied: copied, onFallback: fallback }));
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.copy("Manual value"); });
  expect(result.current.pending).toBe(true);
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(await pending).toBe(false);
  expect(result.current.fallbackText).toBe("Manual value");
  await act(async () => { held.reject(new Error("late denial")); await Promise.resolve(); });
  expect(result.current.status).toBe("fallback");
  expect(fallback).toHaveBeenCalledOnce(); expect(copied).not.toHaveBeenCalled();
});

it("offers manual copy when browser policy denies access to the clipboard property", async () => {
  vi.stubGlobal("navigator", Object.defineProperty({}, "clipboard", { get() { throw new Error("Clipboard is blocked"); } }));
  const fallback = vi.fn();
  const { result } = renderHook(() => useCopy({ onFallback: fallback }));
  let success = true;
  await act(async () => { success = await result.current.copy("Policy-blocked text"); });
  expect(success).toBe(false);
  expect(result.current.fallbackText).toBe("Policy-blocked text");
  expect(fallback).toHaveBeenCalledOnce();
});

it("a newer explicit copy retires the prior operation without waiting for its adapter", async () => {
  const firstWrite = deferred(), copied = vi.fn();
  const writeText = vi.fn().mockReturnValueOnce(firstWrite.promise).mockResolvedValueOnce(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { result } = renderHook(() => useCopy({ onCopied: copied }));
  let first!: Promise<boolean>, second = false;
  act(() => { first = result.current.copy("Old"); });
  await act(async () => { second = await result.current.copy("New"); });
  expect(second).toBe(true); expect(await first).toBe(false);
  await act(async () => { firstWrite.resolve(); await firstWrite.promise; });
  expect(result.current.copied).toBe(true); expect(copied).toHaveBeenCalledOnce();
});

it("clear cancels pending delivery and leaves the hook reusable", async () => {
  const held = deferred(), copied = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText: () => held.promise } });
  const { result } = renderHook(() => useCopy({ onCopied: copied }));
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.copy("Value"); });
  act(() => result.current.clear());
  expect(await pending).toBe(false); expect(result.current.status).toBe("idle");
  await act(async () => { held.resolve(); await held.promise; });
  expect(copied).not.toHaveBeenCalled();
});

it("unmount settles a pending operation without success or fallback callbacks", async () => {
  const held = deferred(), copied = vi.fn(), fallback = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText: () => held.promise } });
  const { result, unmount } = renderHook(() => useCopy({ onCopied: copied, onFallback: fallback }));
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.copy("Value"); });
  unmount();
  expect(await pending).toBe(false);
  await act(async () => { held.resolve(); await held.promise; });
  expect(copied).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
});

it("a text/resource change, including an ABA return, cannot deliver the prior result", async () => {
  const held = deferred(), copied = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText: () => held.promise } });
  const { result, rerender } = renderHook(({ key }) => useCopy({ scopeKey: key, onCopied: copied }), { initialProps: { key: "one" } });
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.copy("Old one"); });
  rerender({ key: "two" }); rerender({ key: "one" });
  expect(await pending).toBe(false);
  await act(async () => { held.resolve(); await held.promise; });
  expect(result.current.status).toBe("idle"); expect(copied).not.toHaveBeenCalled();
});

it("an earlier Copied timer cannot reset a newer pending or successful operation", async () => {
  vi.useFakeTimers();
  const held = deferred();
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(held.promise);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { result } = renderHook(() => useCopy());
  await act(async () => { await result.current.copy("First"); });
  act(() => vi.advanceTimersByTime(1500));
  act(() => { void result.current.copy("Second"); });
  act(() => vi.advanceTimersByTime(500));
  expect(result.current.pending).toBe(true);
  await act(async () => { held.resolve(); await held.promise; });
  expect(result.current.copied).toBe(true);
  act(() => vi.advanceTimersByTime(1500)); expect(result.current.copied).toBe(true);
  act(() => vi.advanceTimersByTime(500)); expect(result.current.status).toBe("idle");
});

/**
 * useTestFireFlag — Settings Test-button latch semantics, shared by
 * the self-driven overlay widgets (multichat + Stream Studio family).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTestFireFlag } from "../useTestFireFlag";
import { TEST_DURATION_MS } from "@/components/overlay/widgetLifecycle";
import type { LiveGamePayload } from "@/components/overlay/types";

type Props = { live: LiveGamePayload | null | undefined };

function mount(initialLive: Props["live"], widgetId = "chat-poll") {
  return renderHook(({ live }: Props) => useTestFireFlag(live, widgetId), {
    initialProps: { live: initialLive } as Props,
  });
}

describe("useTestFireFlag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays false without a payload and for non-test payloads", () => {
    const { result, rerender } = mount(undefined);
    expect(result.current).toBe(false);
    rerender({ live: { result: "win", map: "Goldenaura LE" } });
    expect(result.current).toBe(false);
  });

  it("flips on for a targeted test payload and for an untargeted Test all", () => {
    const { result, rerender } = mount(undefined);
    rerender({ live: { isTest: true, testWidget: "chat-poll" } });
    expect(result.current).toBe(true);

    const untargeted = mount(undefined);
    untargeted.rerender({ live: { isTest: true } });
    expect(untargeted.result.current).toBe(true);
  });

  it("ignores a test payload targeting a different widget", () => {
    const { result, rerender } = mount(undefined);
    rerender({ live: { isTest: true, testWidget: "multichat" } });
    expect(result.current).toBe(false);
  });

  it("latches across non-test payload deliveries mid-window", () => {
    const { result, rerender } = mount(undefined);
    rerender({ live: { isTest: true, testWidget: "chat-poll" } });
    expect(result.current).toBe(true);
    // Socket resync replays the latest REAL snapshot (or a game ends)
    // mid-demo — the run must survive.
    rerender({ live: { result: "loss", map: "Ruby Rock LE" } });
    expect(result.current).toBe(true);
    // And the self-cap timer armed by the test payload still fires.
    act(() => {
      vi.advanceTimersByTime(TEST_DURATION_MS);
    });
    expect(result.current).toBe(false);
  });

  it("clears immediately on live === null (overlay:clear / Stop)", () => {
    const { result, rerender } = mount(undefined);
    rerender({ live: { isTest: true, testWidget: "chat-poll" } });
    expect(result.current).toBe(true);
    rerender({ live: null });
    expect(result.current).toBe(false);
    // The stale stop timer must not resurrect anything.
    act(() => {
      vi.advanceTimersByTime(TEST_DURATION_MS);
    });
    expect(result.current).toBe(false);
  });

  it("self-caps at TEST_DURATION_MS and re-arms on a fresh test payload", () => {
    const { result, rerender } = mount(undefined);
    rerender({ live: { isTest: true, testWidget: "chat-poll" } });
    act(() => {
      vi.advanceTimersByTime(TEST_DURATION_MS - 1);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
    // A second Test click re-arms a full window.
    rerender({ live: { isTest: true, testWidget: "chat-poll" } });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(TEST_DURATION_MS - 1);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });
});

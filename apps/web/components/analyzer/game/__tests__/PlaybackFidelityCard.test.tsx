import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackFidelityCard } from "../PlaybackFidelityCard";
import { PlaybackAccuracyBadge } from "../PlaybackAccuracyBadge";
import { sanitizeMapPlayback } from "@/lib/mapReplay";
import { makePlayback } from "@/lib/__tests__/segmentedPlayback.fixture";
import type { MapReplayController } from "@/lib/useMapReplay";

const controller = (patch: Partial<MapReplayController> = {}): MapReplayController => ({
  playback: null, isLoading: false, error: undefined, canRefresh: true, refreshing: false,
  refreshMessage: "", refresh: vi.fn(async () => undefined), completedRequestId: null, ...patch,
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("playback quality guidance", () => {
  it("keeps static CPU guidance out of live regions and shows real offline presence", () => {
    render(<PlaybackFidelityCard controller={controller({ agentPresence: "offline" })} recorded={false} />);
    expect(screen.getByText("Standard")).toBeTruthy();
    expect(screen.getByText("Desktop app offline")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Generate accurate playback" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(/significantly more CPU/).closest("details")).toBeTruthy();
  });
  it("announces job messages while elapsed recording time changes without another live region", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-25T04:00:00Z"));
    render(<PlaybackFidelityCard recorded={false} controller={controller({ phase: "recording", refreshing: true,
      recordingStartedAt: Date.now() - 61000, refreshMessage: "Recording the replay." })} />);
    expect(screen.getByText(/1:01 elapsed/).getAttribute("aria-current")).toBe("step");
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText(/1:03 elapsed/)).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Recording the replay.");
  });
  it("opens and focuses the same disclosure from the readable canvas accuracy badge", () => {
    render(<div data-playback-section><PlaybackFidelityCard controller={controller()} recorded={true} />
      <PlaybackAccuracyBadge playback={sanitizeMapPlayback(makePlayback())!} estimatedCreep={false} /></div>);
    const summary = screen.getByText("What happens?");
    expect(summary.closest("details")!.open).toBe(false);
    fireEvent.click(screen.getByRole("link", { name: "Replay accuracy" }));
    expect(summary.closest("details")!.open).toBe(true);
    expect(document.activeElement).toBe(summary);
    expect(screen.getByRole("link", { name: "Replay accuracy" }).className).toContain("text-xs");
    expect(screen.queryByRole("button", { name: "Generate accurate playback" })).toBeNull();
  });
});

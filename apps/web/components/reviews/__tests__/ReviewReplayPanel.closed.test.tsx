import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReviewAnalysis } from "@/lib/reviews";
const h = vi.hoisted(() => ({ unmounted: vi.fn(), api: vi.fn((_path: string | null) => ({ data: undefined, isLoading: false })) }));
vi.mock("@/lib/usePublicApi", () => ({ usePublicApi: h.api }));
vi.mock("@/components/analyzer/game/BuildOrderColumns", () => ({ BuildOrderColumns: () => null }));
vi.mock("@/components/analyzer/game/replay/ReplayStage", () => ({ ReplayStage: () => null }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/analyzer/game/InteractiveTimeline", async () => {
  const { useEffect } = await import("react");
  return { InteractiveTimeline: () => { useEffect(() => () => h.unmounted(), []); return <div>Loaded replay timeline</div>; } };
});
import { ReviewReplayPanel } from "../ReviewReplayPanel";
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("unmounts an already-loaded replay when its request closes and disables playback hooks", () => {
  const props = { requestId: "request", analysis: { requestId: "request", playback: { mode: "none" }, game: { durationSec: 640 } } as ReviewAnalysis,
    analysisError: undefined, seekRequest: null, onTimeChange: vi.fn(), onPlaybackAvailable: vi.fn(), mapMarkers: [], onMarkerClick: vi.fn(), commentMarkers: [], onCommentMarker: vi.fn() };
  const view = render(<ReviewReplayPanel {...props} />);
  expect(screen.getByText("Loaded replay timeline")).toBeTruthy();
  view.rerender(<ReviewReplayPanel {...props} closed />);
  expect(screen.queryByText("Loaded replay timeline")).toBeNull(); expect(h.unmounted).toHaveBeenCalledOnce();
  expect(screen.getByRole("status").textContent).toContain("This request is closed, so its replay is no longer shared");
  expect(props.onPlaybackAvailable).toHaveBeenLastCalledWith(false);
  expect(h.api.mock.calls.slice(-2).every((args) => args[0] === null)).toBe(true);
});

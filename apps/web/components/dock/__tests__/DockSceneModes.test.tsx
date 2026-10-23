import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DockScenes, DockTimer } from "../DockScenes";
import type { DockPost } from "../dockActions";
import { DOCK_QUICK_MINUTES } from "../dockConstants";
import { DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";
import { STUDIO_SCENE_LABELS, type StudioSceneMode } from "@/lib/multichat/sceneModes";
const onPost = vi.fn<DockPost>(async () => DEFAULT_STUDIO_STATE);
const broll = DEFAULT_STUDIO_STATE.broll;
beforeEach(() => { localStorage.clear(); onPost.mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it.each(Object.keys(STUDIO_SCENE_LABELS) as StudioSceneMode[])("activates %s without inventing a stream start", async (mode) => {
  render(<DockScenes token="one" scene={null} broll={broll} busy={false} onPost={onPost} />);
  fireEvent.click(screen.getByRole("button", { name: STUDIO_SCENE_LABELS[mode] }));
  await waitFor(() => expect(onPost).toHaveBeenCalled());
  expect(onPost.mock.calls[0][0]).toMatchObject({ scene: { mode } });
  expect(onPost.mock.calls[0][0]).not.toHaveProperty("streamStartMs");
});
it.each(["starting", "ending"] as const)("Go live from %s has success styling and only Starting Soon stamps an unset start", async (mode) => {
  render(<DockScenes scene={{ mode, message: "", countdownEndsAt: null, setAtMs: 1 }} broll={broll} busy={false} onPost={onPost} />);
  const live = screen.getByRole("button", { name: "Go live" });
  expect(live.className).toContain("text-success"); expect(live.className).not.toContain("text-danger");
  fireEvent.click(live); await waitFor(() => expect(onPost).toHaveBeenCalled());
  expect(onPost.mock.calls[0][0]).toEqual(mode === "starting" ? { scene: null, streamStartMs: expect.any(Number) } : { scene: null });
});
it("uses the same four quick minutes for scenes and standalone timers", () => {
  const view = render(<DockScenes scene={null} broll={broll} busy={false} onPost={onPost} />);
  for (const m of DOCK_QUICK_MINUTES) expect(screen.getByRole("button", { name: `${m}m` })).toBeTruthy();
  view.unmount(); render(<DockTimer timer={null} busy={false} onPost={onPost} />);
  for (const m of DOCK_QUICK_MINUTES) expect(screen.getByRole("button", { name: `${m}m` })).toBeTruthy();
});
it("keeps five distinct reusable/removable messages isolated to each token", async () => {
  const view = render(<DockScenes token="one" scene={null} broll={broll} busy={false} onPost={onPost} />);
  for (const message of ["one", "two", "three", "four", "five", "six", "three"]) {
    fireEvent.change(screen.getByPlaceholderText(/Optional message/), { target: { value: message } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "BRB" })); });
  }
  expect(JSON.parse(localStorage.getItem("sc2tools:dock:one:scene-messages")!)).toEqual(["three", "six", "five", "four", "two"]);
  fireEvent.click(screen.getByRole("button", { name: "five" }));
  expect((screen.getByPlaceholderText(/Optional message/) as HTMLInputElement).value).toBe("five");
  fireEvent.click(screen.getByRole("button", { name: "Remove saved message: five" }));
  expect(screen.queryByRole("button", { name: "five" })).toBeNull();
  view.rerender(<DockScenes token="two" scene={null} broll={broll} busy={false} onPost={onPost} />);
  expect(screen.queryByLabelText("Saved scene messages")).toBeNull();
});
it("keeps scene controls and presets usable when browser storage throws", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
  render(<DockScenes token="one" scene={null} broll={broll} busy={false} onPost={onPost} />);
  fireEvent.change(screen.getByPlaceholderText(/Optional message/), { target: { value: "Tea break" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Intermission" })); });
  expect(screen.getByRole("button", { name: "Tea break" })).toBeTruthy();
});

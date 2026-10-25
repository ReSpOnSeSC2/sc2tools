import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayStage } from "../ReplayStage";
import { payload } from "./fixtures";
import { parseReplayPreferences, REPLAY_PREFS_KEY } from "@/lib/useReplayPreferences";
import { adjacentReplayMarker } from "@/lib/replayControls";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("replay review controls", () => {
  it("restores slow motion, rail and mobile panel preferences across games", () => {
    window.localStorage.setItem(REPLAY_PREFS_KEY, JSON.stringify({ speed: 0.5, rails: { production: false, build: true }, productionSide: "opp", buildFilter: "me", showWorkers: true, autoScroll: false, panelTab: "build", panelOpen: true, volume: 0.2 }));
    const first = render(<ReplayStage playback={payload()} gameId="first" />);
    expect(screen.getByRole("button", { name: /playback speed/i }).textContent).toBe("0.5×");
    expect((screen.getByRole("slider", { name: "Replay music volume" }) as HTMLInputElement).value).toBe("20");
    fireEvent.change(screen.getByRole("slider", { name: "Replay music volume" }), { target: { value: "30" } });
    expect(screen.getByRole("tab", { name: "Build order" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Show production & build order/i }));
    first.unmount();
    render(<ReplayStage playback={payload()} gameId="second" />);
    expect(screen.getByRole("button", { name: /Show production & build order/i }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect((screen.getByRole("slider", { name: "Replay music volume" }) as HTMLInputElement).value).toBe("30");
  });

  it("seeks and pauses from focused map shortcuts, clamps jumps, and announces explicit seeks", () => {
    const onStageSeek = vi.fn();
    render(<ReplayStage playback={payload()} onStageSeek={onStageSeek} />);
    const stage = screen.getByTestId("replay-stage"); stage.focus();
    fireEvent.keyDown(stage, { key: "5" }); expect(onStageSeek).toHaveBeenLastCalledWith(300);
    fireEvent.keyDown(stage, { key: "ArrowRight", shiftKey: true }); expect(onStageSeek).toHaveBeenLastCalledWith(305);
    fireEvent.keyDown(stage, { key: "j" }); expect(onStageSeek).toHaveBeenLastCalledWith(295);
    fireEvent.keyDown(stage, { key: "." }); expect(onStageSeek).toHaveBeenLastCalledWith(295 + 1 / 22.4);
    fireEvent.keyDown(stage, { key: "End" });
    fireEvent.keyDown(stage, { key: "l" }); expect(onStageSeek).toHaveBeenLastCalledWith(600);
    expect(screen.getByRole("status").textContent).toBe("Playback at 10:00 of 10:00");
    fireEvent.keyDown(stage, { key: "k" }); expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    const calls = onStageSeek.mock.calls.length;
    fireEvent.keyDown(stage, { key: "." }); expect(onStageSeek).toHaveBeenCalledTimes(calls);
  });

  it("keeps native buttons, sliders, settings Escape, modifiers and typing independent", () => {
    const onStageSeek = vi.fn(); render(<ReplayStage playback={payload()} onStageSeek={onStageSeek} />);
    const stage = screen.getByTestId("replay-stage");
    for (const tag of ["input", "textarea", "select", "button", "a"]) {
      const field = document.createElement(tag); stage.append(field); field.focus();
      fireEvent.keyDown(field, { key: "l" }); fireEvent.keyDown(field, { key: " " }); field.remove();
    }
    const editable = document.createElement("div"); editable.contentEditable = "true"; editable.setAttribute("contenteditable", "true"); stage.append(editable);
    fireEvent.keyDown(editable, { key: "l" }); editable.remove();
    fireEvent.keyDown(stage, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(stage, { key: "l", ctrlKey: true });
    fireEvent.keyDown(stage, { key: "l", isComposing: true });
    expect(onStageSeek).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replay display settings" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Replay display settings" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("supports slowest speed and restores focus after the shortcut dialog closes", () => {
    render(<ReplayStage playback={payload()} />); const stage = screen.getByTestId("replay-stage"); stage.focus();
    for (let n = 0; n < 10; n++) fireEvent.keyDown(stage, { key: "[" });
    expect(screen.getByRole("button", { name: /playback speed/i }).textContent).toBe("0.25×");
    fireEvent.keyDown(stage, { key: "?", shiftKey: true }); expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(stage);
  });

  it("jumps through real event times without wrapping or trusting marker order", () => {
    expect(adjacentReplayMarker([{ t: 40 }, { t: 5 }, { t: 20 }, { t: NaN }], 20, 1)).toBe(40);
    expect(adjacentReplayMarker([{ t: 40 }, { t: 5 }, { t: 20 }], 20, -1)).toBe(5);
    expect(adjacentReplayMarker([], 0, 1)).toBeNull();
  });

  it("rejects broken and unbounded preferences without leaking unknown fields", () => {
    expect(parseReplayPreferences("{" )).toEqual({}); expect(parseReplayPreferences(" ".repeat(4097))).toEqual({});
    expect(parseReplayPreferences(JSON.stringify({ speed: 99, volume: 4, panelOpen: "yes", showWorkers: true, token: "private" }))).toEqual({ showWorkers: true });
  });

  it("still plays and seeks when device storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const seek = vi.fn(); render(<ReplayStage playback={payload()} onStageSeek={seek} />);
    fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" })); expect(seek).toHaveBeenCalledWith(10);
    fireEvent.click(screen.getByRole("button", { name: "Play" })); expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });
});

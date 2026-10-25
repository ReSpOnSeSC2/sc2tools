import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BattleSnapshot } from "../BattleSnapshot";
import { MapStill } from "../MapStill";
import type { MapPlayback } from "@/lib/mapReplay";
const state = vi.hoisted(() => ({ draw: vi.fn(), observe: vi.fn(), disconnect: vi.fn(), resize: null as (() => void) | null }));
vi.mock("@/components/analyzer/game/replay/mapCanvasRenderer", () => ({ renderFrame: state.draw }));
const payload: MapPlayback = { v: 5, mapName: "Alcyone LE", gameLength: 600, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, spawns: [], battles: [], buildings: [], units: [], resources: [], stats: { me: [], opp: [] } };
beforeEach(() => { state.draw.mockClear(); state.observe.mockClear(); state.disconnect.mockClear(); state.resize = null; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("battle snapshots", () => {
  it("uses the real player renderer's precise time/point contract with bounded still redraws and complete cleanup", () => {
    vi.useFakeTimers(); vi.stubGlobal("devicePixelRatio", 2); const frame = vi.fn(); vi.stubGlobal("requestAnimationFrame", frame);
    const transform = vi.fn(); vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform: transform } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 200));
    vi.stubGlobal("ResizeObserver", class { observe = state.observe; disconnect = state.disconnect; unobserve() {} constructor(callback: ResizeObserverCallback) { state.resize = () => callback([], this as unknown as ResizeObserver); } });
    const view = render(<MapStill playback={payload} myRace="P" oppRace="Zerg" moment={{ id: "fight", time: 150.25, caption: "First recorded casualty cluster", point: { x: 10, y: 20 } }} />);
    expect(state.draw).toHaveBeenCalledOnce(); expect(state.draw.mock.calls[0][2]).toBe(payload); expect(state.draw.mock.calls[0][3]).toBe(150.25);
    expect(state.draw.mock.calls[0][6]).toEqual([{ id: "fight", t: 150.25, x: 10, y: 20, label: "!", active: true }]);
    expect(transform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    const canvas = screen.getByRole("img") as HTMLCanvasElement; expect([canvas.width, canvas.height]).toEqual([640, 400]);
    canvas.parentElement!.style.setProperty("--race-protoss", "233 185 40"); canvas.parentElement!.style.setProperty("--race-zerg", "177 95 210");
    act(() => { vi.advanceTimersByTime(2100); }); expect(state.draw).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0); expect(frame).not.toHaveBeenCalled();
    expect(state.draw.mock.calls[2][7]).toEqual({ entities: "dots", palette: { me: "rgb(233 185 40)", opp: "rgb(177 95 210)" } });
    act(() => { state.resize?.(); }); expect(state.draw).toHaveBeenCalledTimes(4);
    view.unmount(); expect(state.disconnect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    act(() => { state.resize?.(); }); expect(state.draw).toHaveBeenCalledTimes(4);
  });

  it("keeps unknown army samples as gaps, preserves the other side, and seeks through its single figure control", () => {
    const seek = vi.fn(); const view = render(<BattleSnapshot moment={{ id: "swing", time: 30, caption: "Largest sampled lead swing" }} duration={120} onSeek={seek} breakdown={{ ok: true, stats_events: [{ time: 0, army_value: 100 }, { time: 30 }, { time: 60, army_value: 150 }], opp_stats_events: [{ time: 0, army_value: 200 }, { time: 30, army_value: 170 }, { time: 60, army_value: 100 }] }} />);
    expect(screen.getByRole("img", { name: /Recorded army-value samples around 0:30/ })).toBeTruthy();
    expect(view.container.querySelectorAll("circle")).toHaveLength(2); expect(view.container.querySelectorAll("path")).toHaveLength(1);
    expect(view.container.innerHTML).not.toContain("NaN");
    fireEvent.click(screen.getByRole("button", { name: "Seek replay to 0:30: Largest sampled lead swing" })); expect(seek).toHaveBeenCalledWith(30);
    expect(view.container.querySelector("button button, button a")).toBeNull();
    view.rerender(<BattleSnapshot moment={{ id: "swing", time: 30, caption: "Largest sampled lead swing" }} duration={120} onSeek={seek} breakdown={{ ok: true, stats_events: [{ time: 0, army_value: 100 }, { time: 90, army_value: 150 }] }} />);
    expect(view.container.querySelectorAll("path")).toHaveLength(0); expect(view.container.querySelectorAll("circle")).toHaveLength(2);
    view.rerender(<BattleSnapshot moment={{ id: "swing", time: 30, caption: "Largest sampled lead swing" }} duration={120} onSeek={seek} />);
    expect(screen.getByText("No army-value samples near this moment.")).toBeTruthy(); expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Recorded army-value samples appear when available. Map snapshots need map data synced by the desktop app.")).toBeTruthy();
    expect(screen.queryByText(/samples shown here/)).toBeNull();
  });

  it("names both sides and races and distinguishes mirror-match dots by fill and outline", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    render(<BattleSnapshot moment={{ id: "mirror", time: 30, caption: "First recorded casualty cluster" }} playback={payload} duration={600} myRace="Zerg" oppRace="Z" onSeek={vi.fn()} />);
    expect(screen.getByText("You · Zerg · solid").getAttribute("style")).toContain("--race-zerg");
    expect(screen.getByText("Opponent · Zerg · outline").getAttribute("style")).toContain("--race-zerg");
    expect(screen.getByText("Units are dots; structures are squares.")).toBeTruthy();
  });
});

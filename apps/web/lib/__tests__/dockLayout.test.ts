import { describe, expect, it, vi } from "vitest";
import { defaultDockLayout, DOCK_LAYOUT_KEY, DOCK_SECTIONS, normalizeDockLayout, orderedDockSections, readDockLayout, writeDockLayout } from "../dockLayout";

describe("bounded browser Dock layout", () => {
  it("defaults to the current expanded sections and a closed b-roll manager", () => {
    expect(defaultDockLayout()).toEqual({ v: 1, collapsed: [], pinned: [], brollOpen: false });
    expect(orderedDockSections(defaultDockLayout())).toEqual(DOCK_SECTIONS.map(section => section.id));
  });
  it("retains valid pin order without accepting unknown IDs or private data", () => {
    const layout = normalizeDockLayout({ v: 1, pinned: ["dock-poll", "dock-clips", "dock-poll", "private-token"], collapsed: ["dock-chat", "unknown"], brollOpen: true, token: "secret" });
    expect(layout).toEqual({ v: 1, pinned: ["dock-poll", "dock-clips"], collapsed: ["dock-chat"], brollOpen: true });
    expect(orderedDockSections(layout)).toEqual(["dock-poll", "dock-clips", ...DOCK_SECTIONS.map(section => section.id).filter(id => id !== "dock-poll" && id !== "dock-clips")]);
    expect(orderedDockSections(layout)).toHaveLength(DOCK_SECTIONS.length);
  });
  it("rejects unbounded or malformed state and survives inaccessible storage", () => {
    for (const value of [null, [], { v: 2 }, "bad"]) expect(normalizeDockLayout(value)).toEqual(defaultDockLayout());
    expect(normalizeDockLayout({ v: 1, pinned: Array(100).fill("dock-chat") }).pinned).toEqual([]);
    expect(readDockLayout({ getItem: () => "x".repeat(5000) })).toEqual(defaultDockLayout());
    expect(readDockLayout({ getItem: () => "{broken" })).toEqual(defaultDockLayout());
    expect(readDockLayout({ getItem: () => { throw new Error("denied"); } })).toEqual(defaultDockLayout());
    expect(() => writeDockLayout({ setItem: () => { throw new Error("denied"); } }, defaultDockLayout())).not.toThrow();
  });
  it("writes only the canonical browser preference key and fields", () => {
    const setItem = vi.fn(); writeDockLayout({ setItem }, normalizeDockLayout({ v: 1, pinned: ["dock-scenes"], rawMessage: "secret" }));
    expect(setItem).toHaveBeenCalledWith(DOCK_LAYOUT_KEY, JSON.stringify({ v: 1, collapsed: [], pinned: ["dock-scenes"], brollOpen: false }));
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockClient } from "../DockClient";
import { DOCK_LAYOUT_KEY, DOCK_SECTIONS } from "@/lib/dockLayout";
import { DEFAULT_STUDIO_STATE } from "@/lib/multichat/useStudioState";

vi.mock("@/lib/multichat/useMultiChat", () => ({ useMultiChat: () => ({ messages: [], events: [], statuses: {}, active: false }) }));
vi.mock("@/lib/multichat/useEngagementReporter", () => ({ useEngagementReporter: () => {} }));
vi.mock("@/lib/multichat/useStudioUpdates", () => ({ useStudioUpdates: () => ({ status: "connected" }), newestStudioSnapshot: (_old: unknown, next: unknown) => next }));
const posts: unknown[] = [];
const studioPosts = () => posts;
const drain = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
beforeEach(() => {
  localStorage.clear(); posts.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/config")) return { ok: true, json: async () => ({ config: { twitch: { enabled: true, channel: "fixture" } } }) };
    if (url.includes("/studio")) {
      if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => DEFAULT_STUDIO_STATE };
    }
    throw new Error("Synthetic unavailable endpoint");
  }));
});
afterEach(async () => { await drain(); cleanup(); vi.unstubAllGlobals(); });

describe("Real Dock layout consumers", () => {
  it("keeps the real poll draft through collapse, pin, reset and browser-only persistence", async () => {
    render(<DockClient token="layout-private-token" />);
    const question = await screen.findByPlaceholderText(/Poll question/);
    fireEvent.change(question, { target: { value: "Next build?" } });
    fireEvent.click(screen.getByRole("button", { name: "Poll", expanded: true }));
    expect(screen.queryByPlaceholderText(/Poll question/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Poll · No poll", expanded: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pin Poll to top" }));
    expect(document.querySelector("[data-dock-section]")?.id).toBe("dock-poll");
    const saved = localStorage.getItem(DOCK_LAYOUT_KEY)!;
    expect(JSON.parse(saved)).toMatchObject({ collapsed: ["dock-poll"], pinned: ["dock-poll"] });
    expect(saved).not.toContain("layout-private-token");
    expect(saved).not.toContain("Next build?");
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect((screen.getByPlaceholderText(/Poll question/) as HTMLInputElement).value).toBe("Next build?");
    expect(document.querySelector("[data-dock-section]")?.id).toBe(DOCK_SECTIONS[0].id);
    expect(studioPosts()).toEqual([]);
  });

  it("continues collapsing and pinning when OBS denies localStorage", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      render(<DockClient token="token" />); await drain();
      fireEvent.click(screen.getByRole("button", { name: "Poll", expanded: true }));
      fireEvent.click(screen.getByRole("button", { name: "Pin Poll to top" }));
      expect(screen.getByRole("button", { name: "Poll · No poll", expanded: false })).toBeTruthy();
      expect(document.querySelector("[data-dock-section]")?.id).toBe("dock-poll");
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  it("tracks the visible section and opens a folded panel before jumping to its header", async () => {
    localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify({ v: 1, collapsed: ["dock-poll"] }));
    let observe: IntersectionObserverCallback | undefined;
    const disconnect = vi.fn(), watched = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { observe = callback; }
      observe = watched; disconnect = disconnect;
    });
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scroll, configurable: true });
    try {
      const view = render(<DockClient token="token" />); await drain();
      expect(watched.mock.calls.filter(([node]) => node.hasAttribute("data-dock-section"))).toHaveLength(DOCK_SECTIONS.length);
      const nav = within(screen.getByRole("navigation", { name: "Dock sections" }));
      act(() => observe?.([{ target: document.getElementById("dock-goals")!, isIntersecting: true, boundingClientRect: { top: 90 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
      expect(nav.getByRole("button", { name: "Goals" }).getAttribute("aria-current")).toBe("location");
      fireEvent.click(nav.getByRole("button", { name: "Poll" }));
      expect(screen.getByRole("button", { name: "Poll", expanded: true })).toBeTruthy();
      await waitFor(() => expect(document.activeElement?.id).toBe("dock-poll-toggle"));
      expect(scroll).toHaveBeenCalledWith({ block: "start" });
      expect(JSON.parse(localStorage.getItem(DOCK_LAYOUT_KEY)!).collapsed).toEqual([]);
      view.unmount(); expect(disconnect).toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
      else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });

  it("keeps unknown clip totals as Loading instead of implying zero while folded", async () => {
    render(<DockClient token="token" />); await drain();
    fireEvent.click(screen.getByRole("button", { name: "Clips", expanded: true }));
    expect(screen.getByRole("button", { name: "Clips · Loading…", expanded: false })).toBeTruthy();
  });

  it("labels connection states and keeps the b-roll manager closed until requested", async () => {
    render(<DockClient token="token" />); await drain();
    expect(screen.getByText("Twitch · connecting")).toBeTruthy();
    expect(screen.queryByPlaceholderText("YouTube URL or video ID")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Manage b-roll", expanded: false }));
    const video = await screen.findByPlaceholderText("YouTube URL or video ID");
    fireEvent.change(video, { target: { value: "abcDEF_1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Manage b-roll", expanded: true }));
    fireEvent.click(screen.getByRole("button", { name: "Manage b-roll", expanded: false }));
    expect((screen.getByPlaceholderText("YouTube URL or video ID") as HTMLInputElement).value).toBe("abcDEF_1234");
    expect(JSON.parse(localStorage.getItem(DOCK_LAYOUT_KEY)!).brollOpen).toBe(true);
    expect(studioPosts()).toEqual([]);
  });

  it("offers a selected full Dock URL if copying is unavailable", async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      render(<DockClient token="token" />); await drain();
      fireEvent.click(screen.getByRole("button", { name: "Copy dock URL" }));
      const field = await screen.findByRole("textbox", { name: "Copy dock URL manually" }) as HTMLInputElement;
      expect(field.value).toBe(window.location.href);
      expect(document.activeElement).toBe(field);
      expect(field.selectionEnd).toBe(field.value.length);
      expect(screen.getByText(/Press Ctrl\+C/)).toBeTruthy();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

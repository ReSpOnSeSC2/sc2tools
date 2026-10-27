import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tour } from "../Tour";

const rect = (top = 120, height = 80) => ({ top, left: 40, right: 440, bottom: top + height, width: 400, height, x: 40, y: top, toJSON: () => ({}) });
let target: HTMLElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let reduced: boolean;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
function flush() { act(() => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(0)); }); }
function props(extra: Partial<ComponentProps<typeof Tour>> = {}): ComponentProps<typeof Tour> {
  return { title: "Today tour", step: { target: "real-target", owner: "Fixture", title: "Read the overview", text: "Read the visible overview." }, target, index: 0, total: 4,
    pending: false, error: null, onNext: vi.fn(), onBack: vi.fn(), onFinish: vi.fn(), onSkip: vi.fn(), onTargetLost: vi.fn(), canReveal: () => true, ...extra };
}
beforeEach(() => {
  reduced = false; frames = new Map(); nextFrame = 0;
  target = document.createElement("section"); target.textContent = "Visible overview"; document.body.append(target);
  vi.spyOn(target, "getBoundingClientRect").mockImplementation(() => rect());
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("innerWidth", 1024); vi.stubGlobal("innerHeight", 900);
});
afterEach(() => { cleanup(); target.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView); else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); });

describe("Tour's actual modal UI", () => {
  it("contains focus, owns Escape and exposes the exact portal ancestor used by suppression", () => {
    const callbacks = props(); render(<Tour {...callbacks} />);
    const dialog = screen.getByRole("dialog", { name: "Read the overview" });
    expect(dialog.closest("[data-tour-overlay]")).not.toBeNull();
    expect(dialog.hasAttribute("data-tour-dialog")).toBe(true);
    expect(within(dialog).getByText("Today tour · Step 1 of 4")).toBeTruthy();
    const skip = within(dialog).getByRole("button", { name: "Skip tour" }), next = within(dialog).getByRole("button", { name: "Next" });
    expect(document.activeElement).toBe(skip);
    next.focus(); fireEvent.keyDown(next, { key: "Tab" }); expect(document.activeElement).toBe(skip);
    fireEvent.keyDown(skip, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(next);
    fireEvent.keyDown(next, { key: "Escape" }); expect(callbacks.onSkip).toHaveBeenCalledOnce();
    expect(callbacks.onFinish).not.toHaveBeenCalled();
  });
  it("uses actual Next/Back actions and leaves the final guide link usable", () => {
    const callbacks = props(); const view = render(<Tour {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" })); expect(callbacks.onNext).toHaveBeenCalledOnce();
    view.rerender(<Tour {...callbacks} index={3} step={{ ...callbacks.step, help: "/help/reading-your-stats" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" })); expect(callbacks.onBack).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Read the guide" }).getAttribute("href")).toBe("/help/reading-your-stats");
    fireEvent.click(screen.getByRole("button", { name: "Finish" })); expect(callbacks.onFinish).toHaveBeenCalledOnce();
  });
  it("renders a phone bottom sheet and uses instant target scrolling under reduced motion", () => {
    reduced = true; vi.stubGlobal("innerWidth", 390);
    vi.mocked(target.getBoundingClientRect).mockReturnValue(rect(1100));
    render(<Tour {...props()} />);
    const dialog = screen.getByRole("dialog", { name: "Read the overview" });
    expect(dialog.style.bottom).toBe("0px"); expect(dialog.style.left).toBe("0px"); expect(dialog.style.right).toBe("0px");
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start", inline: "nearest", behavior: "instant" });
  });
  it.each([0, -40])("leaves an intersecting sticky/section target at its reading position (top %s)", top => {
    vi.mocked(target.getBoundingClientRect).mockReturnValue(rect(top));
    render(<Tour {...props()} />);
    expect(target.scrollIntoView).not.toHaveBeenCalled();
  });
  it("uses instant reveal around a real check-in marker and rolls back an unsafe endpoint before retiring", async () => {
    const marker = document.createElement("section"); marker.dataset.tourBlocker = "check-in"; document.body.append(marker);
    const control = document.createElement("button"); marker.append(control); control.focus();
    vi.stubGlobal("scrollX", 20); vi.stubGlobal("scrollY", 500);
    const originalBodyTop = document.body.scrollTop; document.body.scrollTop = 280;
    const restoreWindow = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const restoreBody = vi.fn(), originalScrollTo = Object.getOwnPropertyDescriptor(document.body, "scrollTo");
    const originalHtmlScrollTo = Object.getOwnPropertyDescriptor(document.documentElement, "scrollTo");
    Object.defineProperty(document.body, "scrollTo", { configurable: true, value: restoreBody });
    Object.defineProperty(document.documentElement, "scrollTo", { configurable: true, value: vi.fn() });
    let allowed = true;
    vi.mocked(target.getBoundingClientRect).mockReturnValue(rect(1100));
    vi.mocked(target.scrollIntoView).mockImplementation(() => { allowed = false; });
    try {
      const callbacks = props({ canReveal: () => allowed }); const view = render(<Tour {...callbacks} />);
      expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start", inline: "nearest", behavior: "instant" });
      expect(restoreWindow).toHaveBeenCalledWith({ left: 20, top: 500, behavior: "instant" });
      expect(restoreBody).toHaveBeenCalledWith({ left: 0, top: 280, behavior: "instant" }); expect(callbacks.onTargetLost).toHaveBeenCalledOnce();
      expect(callbacks.onSkip).not.toHaveBeenCalled(); expect(callbacks.onFinish).not.toHaveBeenCalled();
      view.unmount(); await waitFor(() => expect(document.activeElement).toBe(document.body));
      expect(document.activeElement).not.toBe(control);
    } finally {
      document.body.scrollTop = originalBodyTop;
      marker.remove(); if (originalScrollTo) Object.defineProperty(document.body, "scrollTo", originalScrollTo); else Reflect.deleteProperty(document.body, "scrollTo");
      if (originalHtmlScrollTo) Object.defineProperty(document.documentElement, "scrollTo", originalHtmlScrollTo); else Reflect.deleteProperty(document.documentElement, "scrollTo");
    }
  });
  it("keeps a failed save visible and does not dismiss through Escape while saving", () => {
    const callbacks = props({ index: 3, error: "Your tour progress was not confirmed. Try again." });
    const view = render(<Tour {...callbacks} />);
    expect(screen.getByRole("alert").textContent).toContain("not confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Finish" })); expect(callbacks.onFinish).toHaveBeenCalledOnce();
    view.rerender(<Tour {...callbacks} pending />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(callbacks.onSkip).not.toHaveBeenCalled();
  });
  it("retires queued geometry work, and reports a removed real target without inventing one", async () => {
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    try {
      const callbacks = props(); const view = render(<Tour {...callbacks} />);
      fireEvent.scroll(window); fireEvent.resize(window); expect(frames.size).toBe(1);
      target.remove(); flush(); expect(callbacks.onTargetLost).toHaveBeenCalledOnce();
      fireEvent.resize(window); const queued = [...frames.values()];
      view.unmount(); expect(frames.size).toBe(0);
      act(() => queued.forEach(callback => callback(1))); expect(callbacks.onTargetLost).toHaveBeenCalledOnce();
      await waitFor(() => expect(document.activeElement).toBe(opener));
      expect(document.body.style.overflow).not.toBe("hidden");
    } finally { opener.remove(); }
  });
});

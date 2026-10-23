import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SectionNav } from "../SectionNav";

const items = [{ id: "timings", label: "Timings" }, { id: "army", label: "Army" }, { id: "maps", label: "Maps" }];
let notify: IntersectionObserverCallback;
const observe = vi.fn();
const disconnect = vi.fn();
const scroll = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) { notify = callback; expect(options.rootMargin).toBe("-120px 0px -60% 0px"); }
    observe = observe;
    disconnect = disconnect;
  });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  HTMLElement.prototype.scrollIntoView = scroll;
  window.history.replaceState(null, "", "/guides?band=league:4");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); observe.mockClear(); disconnect.mockClear(); scroll.mockClear(); });
function view() { return render(<><SectionNav items={items} aria-label="Guide contents" />{items.map((item) => <section key={item.id} id={item.id}>{item.label} content</section>)}</>); }
describe("SectionNav", () => {
  it("follows observed sections and scrolls the active chip into view", () => {
    view();
    expect(observe).toHaveBeenCalledTimes(3);
    const army = document.getElementById("army")!;
    const rect = new DOMRect(0, 125, 100, 100);
    act(() => notify([{ target: army, isIntersecting: true, boundingClientRect: rect, intersectionRect: rect, intersectionRatio: 1, rootBounds: null, time: 0 }], {} as IntersectionObserver));
    expect(screen.getByRole("link", { name: "Army" }).getAttribute("aria-current")).toBe("location");
    expect(screen.getByRole("link", { name: "Timings" }).hasAttribute("aria-current")).toBe(false);
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
  });
  it.each([false, true])("replaces the hash and respects reduced motion %s", (reduced) => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: reduced } as MediaQueryList);
    const history = vi.spyOn(window.history, "replaceState");
    view(); scroll.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "Army" }));
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: reduced ? "auto" : "smooth" });
    expect(history).toHaveBeenCalledTimes(1);
    expect(String(history.mock.calls[0][2])).toContain("/guides?band=league:4#army");
    expect(window.location.hash).toBe("#army");
  });
  it("honors deep links, preserves modified clicks and disconnects its observer", () => {
    window.history.replaceState(null, "", "/guides#maps");
    const { unmount } = view();
    expect(screen.getByRole("link", { name: "Maps" }).getAttribute("aria-current")).toBe("location");
    const history = vi.spyOn(window.history, "replaceState");
    fireEvent.click(screen.getByRole("link", { name: "Army" }), { ctrlKey: true });
    expect(history).not.toHaveBeenCalled();
    unmount(); expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

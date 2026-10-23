import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SECTION_FLASH_ATTR,
  SECTION_WAIT_MS,
  revealSectionAnchor,
  sectionIdFromHash,
} from "../revealSectionAnchor";

let scrollIntoView: ReturnType<typeof vi.fn>;
const originalScroll = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  vi.useRealTimers();
  HTMLElement.prototype.scrollIntoView = originalScroll;
  document.body.innerHTML = "";
});

function addSection(id: string): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  document.body.appendChild(el);
  return el;
}

/** Let the MutationObserver callback run. */
const flushObserver = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sectionIdFromHash", () => {
  it("reads the id an anchor names", () => {
    expect(sectionIdFromHash("#platform-connections")).toBe("platform-connections");
    expect(sectionIdFromHash("#caf%C3%A9")).toBe("café");
    expect(sectionIdFromHash("#%E0%A4%A")).toBe("%E0%A4%A");
    expect(sectionIdFromHash("")).toBeNull();
    expect(sectionIdFromHash("#")).toBeNull();
  });
});

describe("revealSectionAnchor", () => {
  it("does nothing without an anchor", () => {
    const stop = revealSectionAnchor("");
    expect(scrollIntoView).not.toHaveBeenCalled();
    stop();
  });

  it("scrolls smoothly, or instantly under reduced motion", () => {
    addSection("a");
    revealSectionAnchor("#a")();
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start", behavior: "smooth" });
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      revealSectionAnchor("#a")();
      expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start", behavior: "auto" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("removes the highlight when cleaned up early", () => {
    const el = addSection("a");
    const stop = revealSectionAnchor("#a");
    expect(el.getAttribute(SECTION_FLASH_ATTR)).toBe("on");
    stop();
    expect(el.hasAttribute(SECTION_FLASH_ATTR)).toBe(false);
  });

  it("stops waiting once cleaned up (the tab changed)", async () => {
    const stop = revealSectionAnchor("#late");
    stop();
    addSection("late");
    await flushObserver();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("gives up on a section that never appears", async () => {
    vi.useFakeTimers();
    revealSectionAnchor("#late");
    vi.advanceTimersByTime(SECTION_WAIT_MS);
    vi.useRealTimers();
    addSection("late");
    await flushObserver();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

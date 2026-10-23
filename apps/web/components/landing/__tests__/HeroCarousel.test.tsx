import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HeroCarousel } from "../HeroCarousel";

const slides = [{ id: "a", label: "First", content: <p>First product</p> }, { id: "b", label: "Second", content: <p>Second product</p> }];
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() })); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("HeroCarousel", () => {
  const active = () => screen.getAllByRole("button").find((button) => button.getAttribute("aria-current") === "true")?.getAttribute("aria-label");
  it("lets players pause permanently and makes manual navigation polite", () => {
    const { container } = render(<HeroCarousel slides={slides} />);
    expect(container.querySelector("section")?.getAttribute("aria-live")).toBe("off");
    fireEvent.click(screen.getByRole("button", { name: "Pause slideshow" }));
    act(() => vi.advanceTimersByTime(6000)); expect(active()).toContain("First");
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(active()).toContain("Second"); expect(container.querySelector("section")?.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("tab")).toBeNull();
  });
  it("does not advance in a hidden document", () => {
    render(<HeroCarousel slides={slides} />);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange")); act(() => vi.advanceTimersByTime(12000));
    expect(active()).toContain("First");
  });
  it("swipes on tablets and keeps inactive slides inert", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const { container } = render(<HeroCarousel slides={slides} />);
    const list = container.querySelector("ul")!;
    fireEvent.pointerDown(list, { clientX: 100, clientY: 50 }); fireEvent.pointerUp(list, { clientX: 40, clientY: 52 });
    expect(active()).toContain("Second"); expect(list.querySelector("li")?.hasAttribute("inert")).toBe(true);
  });
});

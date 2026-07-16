import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapArtwork, MapLabel } from "../MapArtwork";

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MapArtwork", () => {
  it("renders a lazy real image and keeps the map name as text", () => {
    const { container } = render(<MapLabel name="Ruby Rock" />);
    expect(screen.getByText("Ruby Rock")).toBeTruthy();
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toContain("Ruby%20Rock%20LE");
    expect(image.getAttribute("loading")).toBe("lazy");
  });

  it("falls back locally when an image request fails", () => {
    const { container } = render(<MapArtwork mapName="Ruby Rock" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("[data-map-artwork='fallback']")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("never emits an image request for an unknown map", () => {
    const { container } = render(<MapLabel name="Unknown Test Map" />);
    expect(screen.getByText("Unknown Test Map")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("portals the artwork preview above clipping containers on hover", () => {
    vi.useFakeTimers();
    const { container } = render(<MapLabel name="Ruby Rock" preview />);
    const wrapper = container.firstElementChild as HTMLElement;
    mockRect(wrapper, { left: 300, top: 300, width: 100, height: 24 });

    expect(wrapper.getAttribute("title")).toBeNull();
    expect(wrapper.getAttribute("tabindex")).toBeNull();
    expect(container.querySelector("[data-map-preview]")).toBeNull();

    fireEvent.mouseEnter(wrapper);

    const preview = document.body.querySelector<HTMLElement>(
      "[data-map-preview]",
    );
    expect(preview).toBeTruthy();
    expect(preview?.parentElement).toBe(document.body);
    expect(container.contains(preview)).toBe(false);
    expect(preview?.className.includes("fixed")).toBe(true);
    expect(preview?.className.includes("z-[55]")).toBe(true);
    expect(preview?.getAttribute("data-placement")).toBe("top");
    expect(preview?.style.left).toBe("238px");
    expect(preview?.style.top).toBe("164px");

    fireEvent.mouseLeave(wrapper);
    expect(document.body.querySelector("[data-map-preview]")).toBeTruthy();
    act(() => vi.advanceTimersByTime(120));
    expect(document.body.querySelector("[data-map-preview]")).toBeNull();
  });

  it("keeps the decorative preview out of the keyboard tab order", () => {
    const { container } = render(<MapLabel name="Ruby Rock" preview />);
    const wrapper = container.firstElementChild as HTMLElement;
    mockRect(wrapper, { left: 300, top: 300, width: 100, height: 24 });

    fireEvent.focus(wrapper);
    expect(document.body.querySelector("[data-map-preview]")).toBeNull();
    expect(wrapper.getAttribute("tabindex")).toBeNull();
  });

  it("stays open while the pointer inspects the preview and closes on Escape", () => {
    vi.useFakeTimers();
    const { container } = render(<MapLabel name="Ruby Rock" preview />);
    const wrapper = container.firstElementChild as HTMLElement;
    mockRect(wrapper, { left: 300, top: 300, width: 100, height: 24 });

    fireEvent.mouseEnter(wrapper);
    const preview = document.body.querySelector<HTMLElement>(
      "[data-map-preview]",
    )!;
    fireEvent.mouseLeave(wrapper);
    fireEvent.mouseEnter(preview);
    act(() => vi.advanceTimersByTime(120));
    expect(document.body.querySelector("[data-map-preview]")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.querySelector("[data-map-preview]")).toBeNull();
  });

  it("flips below the trigger and clamps to narrow viewport edges", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(320);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(240);
    const { container } = render(<MapLabel name="Ruby Rock" preview />);
    const wrapper = container.firstElementChild as HTMLElement;
    mockRect(wrapper, { left: 296, top: 4, width: 32, height: 24 });

    fireEvent.mouseEnter(wrapper);

    const preview = document.body.querySelector<HTMLElement>(
      "[data-map-preview]",
    );
    expect(preview?.getAttribute("data-placement")).toBe("bottom");
    expect(preview?.style.left).toBe("88px");
    expect(preview?.style.top).toBe("36px");
  });

  it("scales to fit entirely within a very short viewport", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(120);
    const { container } = render(<MapLabel name="Ruby Rock" preview />);
    const wrapper = container.firstElementChild as HTMLElement;
    mockRect(wrapper, { left: 300, top: 40, width: 100, height: 24 });

    fireEvent.mouseEnter(wrapper);

    const preview = document.body.querySelector<HTMLElement>(
      "[data-map-preview]",
    );
    expect(preview?.getAttribute("data-placement")).toBe("bottom");
    expect(preview?.style.height).toBe("40px");
    expect(preview?.style.top).toBe("72px");
    expect(preview?.style.width).toBe("70px");
  });
});

function mockRect(
  element: Element,
  rect: { left: number; top: number; width: number; height: number },
) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => ({}),
  } as DOMRect);
}

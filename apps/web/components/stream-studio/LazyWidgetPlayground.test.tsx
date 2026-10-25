import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyWidgetPlayground } from "./LazyWidgetPlayground";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("lazy playground boundary", () => {
  it("keeps a real image in the server output when JavaScript is unavailable", () => {
    const html = renderToStaticMarkup(<LazyWidgetPlayground initialWidget="ghost-build" />);
    expect(html).toContain("ghost-build.webp"); expect(html).toContain("Open interactive preview");
    expect(renderToStaticMarkup(<LazyWidgetPlayground initialWidget="__proto__" />)).toContain("opponent.webp");
  });
  it("loads the local widget only after the visitor asks", async () => {
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    render(<LazyWidgetPlayground initialWidget="opponent" />);
    expect(screen.queryByRole("region", { name: "Widget playground" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open interactive preview" }));
    expect(await screen.findByRole("region", { name: "Widget playground" }, { timeout: 10_000 })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SaveBar } from "../SaveBar";
import { ABOVE_CHROME_CSS, Z_LAYERS, aboveChromeBottomPx } from "./bottomLayer";

afterEach(cleanup);

describe("SaveBar placement", () => {
  it("floats above the mobile tab bar using var(--chrome-bottom)", () => {
    render(<SaveBar visible onSave={() => {}} />);
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    expect(bar.className).toContain("bottom-above-chrome");
    expect(bar.className).not.toMatch(/(^|\s)bottom-0(\s|$)/);
    expect(ABOVE_CHROME_CSS).toContain("var(--chrome-bottom");
    // A 64px tab bar (390px phone) puts Save 12px above it.
    expect(aboveChromeBottomPx("64px")).toBe(76);
    // Outside the app (no tab bar) only the home indicator counts.
    expect(aboveChromeBottomPx(null, 34)).toBe(46);
    expect(aboveChromeBottomPx(null)).toBe(12);
  });

  it("sits on the banner layer, above the nav", () => {
    render(<SaveBar visible onSave={() => {}} />);
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    expect(bar.className).toContain("z-banner");
    expect(Z_LAYERS.banner).toBe(50);
    expect(Z_LAYERS.banner).toBeGreaterThan(Z_LAYERS.nav);
  });

  it("renders nothing without changes and saves or discards on click", () => {
    const onSave = vi.fn();
    const onReset = vi.fn();
    const view = render(<SaveBar visible={false} onSave={onSave} onReset={onReset} />);
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    view.rerender(<SaveBar visible onSave={onSave} onReset={onReset} />);
    fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /Discard/ })[0]);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

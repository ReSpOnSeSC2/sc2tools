import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HelpLink } from "../HelpLink";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));

afterEach(cleanup);

/** Modal moves focus on a 0 ms timer. */
function flushFocus() {
  act(() => {
    vi.runOnlyPendingTimers();
  });
}

describe("HelpLink", () => {
  it("is a real link to the article that opens it in a side sheet", () => {
    vi.useFakeTimers();
    try {
      render(<HelpLink slug="build-check-in">How build check-in works</HelpLink>);
      const link = screen.getByRole("link", { name: "How build check-in works" });
      expect(link.getAttribute("href")).toBe("/help/build-check-in");
      expect(link.getAttribute("aria-haspopup")).toBe("dialog");
      link.focus();
      fireEvent.click(link);
      flushFocus();

      const dialog = screen.getByRole("dialog", { name: "Build check-in: count the build you went for" });
      expect(dialog.className).toContain("sm:h-[100dvh]");
      expect(dialog.textContent).toContain("What's the plan?");
      expect(within(dialog).getByRole("link", { name: "Open full article" }).getAttribute("href")).toBe(
        "/help/build-check-in",
      );
      expect(dialog.contains(document.activeElement)).toBe(true);

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(link);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onOpen when the reader follows the link, in the sheet or a new tab", () => {
    const onOpen = vi.fn();
    render(<HelpLink slug="stream-dock" onOpen={onOpen}>Dock help</HelpLink>);
    const link = screen.getByRole("link", { name: "Dock help" });
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const stopNavigation = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("click", stopNavigation);
    try {
      fireEvent.click(link, { ctrlKey: true });
    } finally {
      document.removeEventListener("click", stopNavigation);
    }
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("closes from the close button", () => {
    render(<HelpLink slug="stream-dock" />);
    fireEvent.click(screen.getByRole("link", { name: "Stream Dock (your control panel)" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves modified clicks to the browser (new tab)", () => {
    render(<HelpLink slug="stream-dock">Dock help</HelpLink>);
    // Record whether the link handler let the browser act, then stop
    // jsdom from attempting the navigation.
    let preventedByLink: boolean | null = null;
    const stopNavigation = (event: MouseEvent) => {
      preventedByLink = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", stopNavigation);
    try {
      fireEvent.click(screen.getByRole("link", { name: "Dock help" }), { ctrlKey: true });
    } finally {
      document.removeEventListener("click", stopNavigation);
    }
    expect(preventedByLink).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers a compact icon variant named after the article", () => {
    render(<HelpLink slug="obs-overlay-setup" variant="icon" />);
    const icon = screen.getByRole("link", { name: "Help: OBS overlay setup" });
    fireEvent.click(icon);
    expect(screen.getByRole("dialog", { name: "OBS overlay setup" })).toBeTruthy();
  });

  it("renders plain children for an unknown slug instead of a dead link", () => {
    render(<HelpLink slug="does-not-exist">Some text</HelpLink>);
    expect(screen.getByText("Some text")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

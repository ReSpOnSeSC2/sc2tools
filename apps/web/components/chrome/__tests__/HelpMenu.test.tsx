import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HelpMenu } from "../HelpMenu";
import { helpMenuItems } from "../helpMenu";

const nav = vi.hoisted(() => ({ pathname: "/app" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

afterEach(() => {
  cleanup();
  nav.pathname = "/app";
});

const button = () => screen.getByRole("button", { name: "Help & support" });
const items = () => screen.getAllByRole("menuitem");

describe("helpMenuItems", () => {
  it("offers the report form signed in and the support email signed out", () => {
    expect(helpMenuItems(true).map((item) => item.label)).toEqual([
      "Search help",
      "Stream Studio crash course",
      "Download / update the desktop app",
      "Report a problem",
      "Suggest a feature",
      "How reports work",
      "Support SC2 Tools",
    ]);
    const signedOut = helpMenuItems(false);
    expect(signedOut.some((item) => item.report)).toBe(false);
    expect(signedOut.find((item) => item.key === "email-support")?.href).toBe("mailto:responsecoaching@gmail.com");
  });
});

describe("HelpMenu", () => {
  it("opens a menu of links and report actions", () => {
    const onReport = vi.fn();
    render(<HelpMenu signedIn onReport={onReport} />);
    expect(button().getAttribute("aria-haspopup")).toBe("menu");
    expect(button().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: "Help & support" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Search help" }).getAttribute("href")).toBe("/help");
    expect(screen.getByRole("menuitem", { name: "Support SC2 Tools" }).getAttribute("href")).toBe("/donate");
    expect(screen.getAllByRole("separator")).toHaveLength(2);

    fireEvent.click(screen.getByRole("menuitem", { name: "Report a problem" }));
    expect(onReport).toHaveBeenCalledWith("problem");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("supports the menu-button keyboard pattern", () => {
    render(<HelpMenu signedIn onReport={vi.fn()} />);
    fireEvent.keyDown(button(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items()[0]);

    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items()[1]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items()[items().length - 1]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items()[0]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items()[items().length - 1]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items()[0]);

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button());

    fireEvent.keyDown(button(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(items()[items().length - 1]);
  });

  it("closes on an outside click and on navigation", () => {
    const { rerender } = render(<HelpMenu signedIn onReport={vi.fn()} />);
    fireEvent.click(button());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(button());
    nav.pathname = "/settings";
    rerender(<HelpMenu signedIn onReport={vi.fn()} />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leaves the report items out without a report handler", () => {
    render(<HelpMenu signedIn={false} />);
    fireEvent.click(button());
    expect(screen.queryByRole("menuitem", { name: "Report a problem" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Email support" })).toBeTruthy();
  });
});

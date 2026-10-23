import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HelpSearch } from "../HelpSearch";

afterEach(cleanup);

function type(value: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search help" }), { target: { value } });
}

describe("HelpSearch", () => {
  it("shows ranked results with their topic as you type", () => {
    render(<HelpSearch />);
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
    type("code expired");
    const list = screen.getByRole("list", { name: "Search results" });
    const first = within(list).getAllByRole("link")[0];
    expect(first.getAttribute("href")).toBe("/help/install-and-pair");
    expect(first.textContent).toContain("Install and link the desktop app");
    expect(first.textContent).toContain("Getting started · ");
    expect(screen.getByRole("status").textContent).toMatch(/^\d+ articles?$/);
  });

  it("says when nothing matches", () => {
    render(<HelpSearch />);
    type("zzzzzz");
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("No articles match “zzzzzz”");
  });

  it("moves through results with the arrow keys and back to the field", () => {
    render(<HelpSearch />);
    type("chat");
    const input = screen.getByRole("searchbox", { name: "Search help" });
    const links = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("link");
    expect(links.length).toBeGreaterThan(1);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[0]);
    fireEvent.keyDown(links[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[1]);
    fireEvent.keyDown(links[1], { key: "ArrowUp" });
    fireEvent.keyDown(links[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(input);
  });

  it("clears with Escape or the clear button", () => {
    render(<HelpSearch />);
    const input = screen.getByRole("searchbox", { name: "Search help" }) as HTMLInputElement;
    type("dock");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    type("dock");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("opens results in place when the host handles them", () => {
    const onOpenArticle = vi.fn();
    render(<HelpSearch articleHref={(slug) => `#${slug}`} onOpenArticle={onOpenArticle} />);
    type("stream dock");
    const first = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("link")[0];
    expect(first.getAttribute("href")).toBe("#stream-dock");
    fireEvent.click(first);
    expect(onOpenArticle).toHaveBeenCalledWith("stream-dock");
  });
});

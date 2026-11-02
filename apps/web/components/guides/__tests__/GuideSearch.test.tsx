import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ search: null as { open: ReturnType<typeof vi.fn> } | null }));
vi.mock("@/components/chrome/CommandSearchContext", () => ({ useCommandSearch: () => h.search }));
vi.mock("@/lib/usePageSearchShortcut", () => ({ usePageSearchShortcut: () => {} }));

import { GuideSearch } from "../GuideSearch";

afterEach(() => { cleanup(); h.search = null; });

describe("Find a guide form", () => {
  it("submits to the /search results page on its own", () => {
    render(<GuideSearch />);
    const form = screen.getByRole("search", { name: "Find a guide" }) as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/search");
    expect(form.getAttribute("method")).toBe("get");
    const input = screen.getByRole("searchbox");
    expect(input.getAttribute("name")).toBe("q"); expect(input.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(input, { target: { value: "12 pool" } });
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(false);
    expect((screen.getByRole("button", { name: "Search" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens the guides palette instead when search is available", () => {
    h.search = { open: vi.fn() };
    render(<GuideSearch matchup="PvZ" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "12 pool" } });
    const form = screen.getByRole("search", { name: "Find a guide" });
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(h.search.open).toHaveBeenCalledWith(expect.objectContaining({ scope: "guides", query: "12 pool", defaultMatchup: "PvZ" }));
  });
});

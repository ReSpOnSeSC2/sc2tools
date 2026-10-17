import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetExplorer } from "./WidgetExplorer";
import { WIDGET_GUIDES } from "@/lib/streamStudioLearn";

beforeEach(() => window.history.replaceState(null, "", "/stream-studio/learn"));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("widget learning explorer", () => {
  it("offers every widget and explains the default without requesting private data", () => {
    render(<WidgetExplorer />);
    const navigation = screen.getByRole("navigation", { name: "Choose a widget" });
    expect(within(navigation).getAllByRole("button")).toHaveLength(WIDGET_GUIDES.length);
    const guide = screen.getByRole("article", { name: "Opponent identity guide" });
    expect(within(guide).getByText("All-in-one or its own Browser Source")).toBeTruthy();
    expect(within(guide).getByText("Illustrative data")).toBeTruthy();
    expect(within(guide).getByRole("link", { name: "Open the right settings" }).getAttribute("href")).toBe("/settings?tab=overlay");
  });

  it("opens a widget deep link and exposes its dedicated-source instructions", () => {
    window.history.replaceState(null, "", "/stream-studio/learn?widget=ghost-build#widget-library");
    render(<WidgetExplorer />);
    const guide = screen.getByRole("article", { name: "Ghost Build coach guide" });
    expect(within(guide).getByText("Use its own Browser Source")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Choose a widget" }) as HTMLSelectElement).value).toBe("ghost-build");
  });

  it("filters search results and recovers from an empty search", () => {
    render(<WidgetExplorer />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unfindable-widget-xyz" } });
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByText("No widgets match that search.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(screen.getByRole("article", { name: "Opponent identity guide" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ghost Build coach" } });
    expect(screen.getByRole("article", { name: "Ghost Build coach guide" })).toBeTruthy();
  });

  it("uses category filters and mobile selection with bookmarkable widget choices", () => {
    render(<WidgetExplorer />);
    fireEvent.click(within(screen.getByLabelText("Widget categories")).getByRole("button", { name: "Chat & community" }));
    const navigation = screen.getByRole("navigation", { name: "Choose a widget" });
    expect(within(navigation).queryByRole("button", { name: "Opponent identity" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Choose a widget" }), { target: { value: "chat-poll" } });
    expect(screen.getByRole("article", { name: "Chat poll guide" })).toBeTruthy();
    expect(new URL(window.location.href).searchParams.get("widget")).toBe("chat-poll");
  });

  it("copies the public guide link without any overlay credential", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<WidgetExplorer />);
    fireEvent.click(screen.getByRole("button", { name: "Copy a link to this guide" }));
    await screen.findByRole("button", { name: "Guide link copied" });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/stream-studio/learn?widget=opponent#widget-library`);
  });

  it("opens a related widget across categories and focuses its explanation", () => {
    render(<WidgetExplorer />);
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "practice" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Choose a widget" }), { target: { value: "ghost-build" } });
    const ghost = screen.getByRole("article", { name: "Ghost Build coach guide" });
    fireEvent.click(within(ghost).getByRole("button", { name: "Post-game build" }));
    const relatedGuide = screen.getByRole("article", { name: "Post-game build guide" });
    expect(document.activeElement).toBe(relatedGuide);
    expect((screen.getByRole("combobox", { name: "Category" }) as HTMLSelectElement).value).toBe("all");
  });

  it("ignores an invalid widget id and handles clipboard failure", async () => {
    window.history.replaceState(null, "", "/stream-studio/learn?widget=invalid");
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    render(<WidgetExplorer />);
    expect(screen.getByRole("article", { name: "Opponent identity guide" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy a link to this guide" }));
    expect((await screen.findByRole("textbox", { name: "Copy this public guide link manually" }) as HTMLInputElement).value).toContain("widget=opponent");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ghost Build coach" } });
    expect(screen.queryByRole("textbox", { name: "Copy this public guide link manually" })).toBeNull();
  });
});

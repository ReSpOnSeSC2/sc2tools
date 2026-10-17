import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(within(guide).getByText("Example preview · sample data")).toBeTruthy();
    const preview = within(guide).getByRole("img", { name: "Opponent identity widget preview with sample data" });
    expect(preview.getAttribute("src")).toContain("opponent.webp");
    expect(preview.getAttribute("width")).toBe("1400");
    expect(preview.getAttribute("height")).toBe("900");
    expect(within(guide).getByRole("link", { name: "Open the right settings" }).getAttribute("href")).toBe("/settings?tab=overlay");
  });

  it("opens a widget deep link and exposes its dedicated-source instructions", () => {
    window.history.replaceState(null, "", "/stream-studio/learn?widget=ghost-build#widget-library");
    render(<WidgetExplorer />);
    const guide = screen.getByRole("article", { name: "Ghost Build coach guide" });
    expect(within(guide).getByText("Use its own Browser Source")).toBeTruthy();
    expect(within(guide).getByRole("img", { name: "Ghost Build coach widget preview with sample data" }).getAttribute("src")).toContain("ghost-build.webp");
    expect((screen.getByRole("combobox", { name: "Choose a widget" }) as HTMLSelectElement).value).toBe("ghost-build");
  });

  it("enlarges the selected preview and returns keyboard focus when Escape closes it", async () => {
    render(<WidgetExplorer />);
    const enlarge = screen.getByRole("button", { name: "Enlarge preview" });
    enlarge.focus();
    fireEvent.click(enlarge);
    const dialog = screen.getByRole("dialog", { name: "Opponent identity preview" });
    expect(within(dialog).getByRole("img", { name: "Opponent identity widget preview with sample data" }).getAttribute("src")).toContain("opponent.webp");
    const original = within(dialog).getByRole("link", { name: "Open full-size image" });
    expect(original.getAttribute("href")).toBe("/images/widget-examples/opponent.webp");
    expect(original.getAttribute("target")).toBe("_blank");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" })));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(enlarge);
  });

  it("loads the matching preview for every widget choice", () => {
    render(<WidgetExplorer />);
    const picker = screen.getByRole("combobox", { name: "Choose a widget" });
    for (const guide of WIDGET_GUIDES) {
      fireEvent.change(picker, { target: { value: guide.id } });
      expect(screen.getByRole("img", { name: `${guide.name} widget preview with sample data` }).getAttribute("src")).toContain(`${guide.id}.webp`);
    }
  });

  it("browses filtered thumbnails and focuses the chosen widget guide", () => {
    render(<WidgetExplorer />);
    const disclosure = screen.getByText("Browse widget previews").closest("details")!;
    disclosure.open = true;
    const gallery = screen.getByRole("list", { name: "Widget preview gallery" });
    expect(within(gallery).getAllByRole("button")).toHaveLength(WIDGET_GUIDES.length);
    fireEvent.click(within(gallery).getByRole("button", { name: "Ghost Build coach" }));
    expect(within(gallery).getByRole("button", { name: "Ghost Build coach" }).getAttribute("aria-pressed")).toBe("true");
    const guide = screen.getByRole("article", { name: "Ghost Build coach guide" });
    expect(document.activeElement).toBe(guide);
    expect(new URL(window.location.href).searchParams.get("widget")).toBe("ghost-build");

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ghost Build coach" } });
    expect(within(gallery).getAllByRole("button")).toHaveLength(1);
    expect(within(disclosure).getByText("(1)")).toBeTruthy();
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

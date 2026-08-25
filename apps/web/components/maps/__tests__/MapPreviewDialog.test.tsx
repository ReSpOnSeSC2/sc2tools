import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapPreviewDialog } from "../MapPreviewDialog";

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.style.overflow = "";
});

describe("MapPreviewDialog", () => {
  it("uses the full layout and falls back through the artwork registry", () => {
    const { container } = render(
      <MapPreviewDialog mapName="Ruby Rock" onClose={() => {}} />,
    );

    expect(
      screen.getByRole("dialog", { name: "Ruby Rock map preview" }),
    ).toBeTruthy();
    const layout = screen.getByRole("img", {
      name: "Enlarged preview of Ruby Rock",
    });
    expect(layout.getAttribute("src")).toContain("map=Ruby%20Rock");
    expect(layout.getAttribute("src")).toContain("variant=layout");
    expect(layout.className).toContain("object-contain");

    fireEvent.error(layout);

    const thumbnail = screen.getByRole("img", {
      name: "Enlarged preview of Ruby Rock",
    });
    expect(thumbnail.getAttribute("src")).toContain("Ruby%20Rock%20LE");
    expect(thumbnail.getAttribute("src")).not.toContain("variant=layout");
    expect(thumbnail.className).toContain("object-contain");

    fireEvent.error(thumbnail);
    const fallback = screen.getByRole("img", {
      name: "Enlarged preview of Ruby Rock",
    });
    expect(fallback.getAttribute("data-map-artwork")).toBe("fallback");
    expect(container.ownerDocument.querySelector("img")).toBeNull();
  });

  it("tries raw names and resets the layout attempt when the map changes", () => {
    const { rerender } = render(
      <MapPreviewDialog mapName="Community Test Arena" onClose={() => {}} />,
    );
    const unknownLayout = screen.getByRole("img", {
      name: "Enlarged preview of Community Test Arena",
    });
    expect(unknownLayout.getAttribute("src")).toContain(
      "map=Community%20Test%20Arena",
    );
    expect(unknownLayout.getAttribute("src")).toContain("variant=layout");

    fireEvent.error(unknownLayout);
    const fallback = screen.getByRole("img", {
      name: "Enlarged preview of Community Test Arena",
    });
    expect(fallback.getAttribute("data-map-artwork")).toBe("fallback");
    expect(document.querySelector("img")).toBeNull();

    rerender(<MapPreviewDialog mapName="Acid Plant" onClose={() => {}} />);
    const nextLayout = screen.getByRole("img", {
      name: "Enlarged preview of Acid Plant",
    });
    expect(nextLayout.getAttribute("src")).toContain("map=Acid%20Plant");
    expect(nextLayout.getAttribute("src")).toContain("variant=layout");
  });

  it("retries the full layout when the same map is closed and reopened", () => {
    render(<PreviewHarness initiallyOpen />);

    fireEvent.error(
      screen.getByRole("img", { name: "Enlarged preview of Ruby Rock" }),
    );
    expect(
      screen
        .getByRole("img", { name: "Enlarged preview of Ruby Rock" })
        .getAttribute("src"),
    ).not.toContain("variant=layout");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Ruby Rock" }));

    expect(
      screen
        .getByRole("img", { name: "Enlarged preview of Ruby Rock" })
        .getAttribute("src"),
    ).toContain("variant=layout");
  });

  it("locks scrolling, traps focus, closes on Escape, and restores focus", () => {
    vi.useFakeTimers();
    render(<PreviewHarness />);
    const opener = screen.getByRole("button", { name: "Show Ruby Rock" });
    opener.focus();
    fireEvent.click(opener);

    expect(document.body.style.overflow).toBe("hidden");
    act(() => vi.runOnlyPendingTimers());

    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("dismisses when the backdrop is clicked", () => {
    render(<PreviewHarness initiallyOpen />);
    expect(screen.getByRole("dialog")).toBeTruthy();

    const firstLayout = screen.getByRole("img", {
      name: "Enlarged preview of Ruby Rock",
    });
    fireEvent.error(firstLayout);
    expect(
      screen.getByRole("img", { name: "Enlarged preview of Ruby Rock" })
        .getAttribute("src"),
    ).not.toContain("variant=layout");

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show Ruby Rock" }));
    expect(
      screen
        .getByRole("img", { name: "Enlarged preview of Ruby Rock" })
        .getAttribute("src"),
    ).toContain("variant=layout");
  });
});

function PreviewHarness({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [mapName, setMapName] = useState<string | null>(
    initiallyOpen ? "Ruby Rock" : null,
  );
  return (
    <>
      <button type="button" onClick={() => setMapName("Ruby Rock")}>
        Show Ruby Rock
      </button>
      <MapPreviewDialog mapName={mapName} onClose={() => setMapName(null)} />
    </>
  );
}

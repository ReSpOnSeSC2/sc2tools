import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BuildCard } from "./BuildCard";
import type { DecoratedBuild } from "./types";

const callbacks = {
  onOpen: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onPublish: vi.fn(),
};

function build(overrides: Partial<DecoratedBuild> = {}): DecoratedBuild {
  return {
    slug: "pvt-three-gate",
    name: "PvT 3 Gate",
    race: "Protoss",
    vsRace: "Terran",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BuildCard replay-stat states", () => {
  it("does not describe an unfinished request as zero matches", () => {
    render(<BuildCard build={build({ statsState: "loading" })} {...callbacks} />);

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("No classified replays")).toBeNull();
  });

  it("does not describe an API failure as zero matches", () => {
    render(
      <BuildCard build={build({ statsState: "unavailable" })} {...callbacks} />,
    );

    expect(screen.getByText("Temporarily unavailable")).toBeTruthy();
    expect(screen.queryByText("No classified replays")).toBeNull();
  });

  it("shows zero only after a successful stats response", () => {
    render(<BuildCard build={build({ statsState: "ready" })} {...callbacks} />);

    expect(screen.getByText("No classified replays")).toBeTruthy();
  });

  it("labels the replay sample as a total game count in plain language", () => {
    render(
      <BuildCard
        build={build({
          statsState: "ready",
          stats: {
            name: "PvT 3 Gate",
            wins: 300,
            losses: 276,
            total: 576,
            winRate: 300 / 576,
          },
        })}
        {...callbacks}
      />,
    );

    expect(screen.getByText("Total games: 576")).toBeTruthy();
    expect(screen.queryByText("n = 576")).toBeNull();
  });
});

describe("BuildCard actions menu", () => {
  it("portals every action outside the clipped card and closes on an outside tap", () => {
    const onReclassify = vi.fn();
    render(
      <BuildCard
        build={build()}
        {...callbacks}
        onReclassify={onReclassify}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Build options for PvT 3 Gate" }),
    );

    const menu = screen.getByRole("menu", {
      name: "Build actions for PvT 3 Gate",
    });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toContain("fixed");
    expect(menu.className).toContain("overflow-y-auto");
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Edit", "Reclassify replays", "Publish", "Delete"]);
    for (const item of screen.getAllByRole("menuitem")) {
      expect(item.className).toContain("min-h-11");
    }

    fireEvent.pointerDown(screen.getByTestId("build-menu-scrim"));

    expect(screen.queryByRole("menu", {
      name: "Build actions for PvT 3 Gate",
    })).toBeNull();
    expect(callbacks.onOpen).not.toHaveBeenCalled();
  });

  it("flips above a bottom-edge trigger, supports keyboard navigation, and restores focus", async () => {
    render(
      <BuildCard
        build={build()}
        {...callbacks}
        onReclassify={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Build options for PvT 3 Gate",
    });
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const triggerRect = vi.spyOn(trigger, "getBoundingClientRect");
    triggerRect.mockReturnValue({
      x: viewportWidth - 56,
      y: viewportHeight - 52,
      left: viewportWidth - 56,
      right: viewportWidth - 12,
      top: viewportHeight - 52,
      bottom: viewportHeight - 8,
      width: 44,
      height: 44,
      toJSON: () => ({}),
    });

    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", {
      name: "Build actions for PvT 3 Gate",
    });
    await waitFor(() => expect(menu.dataset.placement).toBe("top"));
    expect(Number.parseFloat(menu.style.top)).toBeLessThan(
      viewportHeight - 52,
    );
    expect(
      Number.parseFloat(menu.style.top) + Number.parseFloat(menu.style.maxHeight),
    ).toBeLessThanOrEqual(viewportHeight - 12);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(12);
    expect(
      Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width),
    ).toBeLessThanOrEqual(viewportWidth - 12);

    triggerRect.mockReturnValue({
      x: viewportWidth - 56,
      y: 12,
      left: viewportWidth - 56,
      right: viewportWidth - 12,
      top: 12,
      bottom: 56,
      width: 44,
      height: 44,
      toJSON: () => ({}),
    });
    fireEvent.scroll(window);
    await waitFor(() => expect(menu.dataset.placement).toBe("bottom"));

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "Edit" }),
      );
    });
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Delete" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu", {
      name: "Build actions for PvT 3 Gate",
    })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

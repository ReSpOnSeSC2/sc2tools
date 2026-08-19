import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReplayIcon } from "../ReplayIcon";
import { ReplayStage } from "../ReplayStage";
import { payload } from "./fixtures";
import { getIconPath } from "@/lib/sc2-icons";
import { SPRITE_BASE } from "@/lib/spriteSheets";

// vitest.config.ts sets globals:false, so React Testing Library never
// registers its automatic cleanup -- without this every render stays
// mounted and the next query matches the previous test's DOM too.
afterEach(() => cleanup());

/**
 * The rails now render the 3D roster renders, with the flat
 * command-card icon as the fallback for names that have no model, and
 * again at runtime when a render 404s.
 */

function iconFor(el: HTMLElement): HTMLImageElement | null {
  return el.querySelector("img");
}

describe("ReplayIcon", () => {
  it("uses the 3D render for a name that has one", () => {
    const { container } = render(<ReplayIcon name="Marine" kind="unit" />);
    const img = iconFor(container);
    expect(img?.getAttribute("src")).toBe(`${SPRITE_BASE}/icons/Marine_blue.webp`);
    expect(img?.getAttribute("data-icon-source")).toBe("sprite");
  });

  it("picks red for the opponent and blue for you, matching the map", () => {
    const { container: mine } = render(<ReplayIcon name="Zealot" kind="unit" side="me" />);
    expect(iconFor(mine)?.getAttribute("src")).toBe(
      `${SPRITE_BASE}/icons/Zealot_blue.webp`,
    );
    const { container: theirs } = render(
      <ReplayIcon name="Zealot" kind="unit" side="opp" />,
    );
    expect(iconFor(theirs)?.getAttribute("src")).toBe(
      `${SPRITE_BASE}/icons/Zealot_red.webp`,
    );
  });

  it("goes through the SAME alias fold the map uses", () => {
    const { container } = render(<ReplayIcon name="BarracksTechLab" kind="structure" />);
    expect(iconFor(container)?.getAttribute("src")).toBe(
      `${SPRITE_BASE}/icons/TechLab_blue.webp`,
    );
  });

  it("falls back to the flat icon for a name with no render", () => {
    // Upgrades have no 3D model at all.
    const { container } = render(<ReplayIcon name="StimPack" kind="upgrade" />);
    const img = iconFor(container);
    expect(img?.getAttribute("src")).toBe(getIconPath("StimPack", "upgrade"));
    expect(img?.getAttribute("src")).toContain("/icons/sc2/");
    expect(img?.getAttribute("data-icon-source")).toBe("flat");
  });

  it("falls back to the flat icon at RUNTIME when the render 404s", () => {
    const { container } = render(<ReplayIcon name="Marine" kind="unit" />);
    const img = iconFor(container);
    expect(img).toBeTruthy();
    expect(img?.getAttribute("data-icon-source")).toBe("sprite");
    fireEvent.error(img as HTMLImageElement);
    const after = iconFor(container);
    expect(after?.getAttribute("src")).toBe(getIconPath("Marine", "unit"));
    expect(after?.getAttribute("data-icon-source")).toBe("flat");
  });

  it("degrades to a monogram when neither exists", () => {
    const { container } = render(<ReplayIcon name="Broodling" kind="unit" />);
    // No 3D render AND no command-card icon for a Broodling.
    expect(iconFor(container)).toBeNull();
    expect(container.textContent).toBe("B");
  });

  it("is decorative: no alt text, hidden from the a11y tree", () => {
    const { container } = render(<ReplayIcon name="Marine" kind="unit" />);
    const img = iconFor(container);
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
    expect(img?.getAttribute("loading")).toBe("lazy");
  });
});

describe("the rails in the stage", () => {
  it("draw their rosters with the 3D renders, not the flat icons", () => {
    render(<ReplayStage playback={payload()} />);
    const rail = screen.getByTestId("replay-production-rail");
    const imgs = [...rail.querySelectorAll("img")];
    expect(imgs.length).toBeGreaterThan(0);
    // Every row that has a render uses it, and it is a plain <img>: no
    // canvas, so the 60 fps loop's sprite module state is untouched.
    const sprites = imgs.filter((i) => i.getAttribute("data-icon-source") === "sprite");
    expect(sprites.length).toBeGreaterThan(0);
    for (const img of sprites) {
      expect(img.getAttribute("src")).toContain(`${SPRITE_BASE}/icons/`);
      expect(img.getAttribute("src")).toMatch(/_(red|blue)\.webp$/);
    }
  });

  it("colours the build-order feed per side", () => {
    render(<ReplayStage playback={payload()} />);
    const feed = screen.getByTestId("replay-build-order-rail");
    const srcs = [...feed.querySelectorAll("img")].map((i) => i.getAttribute("src") ?? "");
    // The fixture has both sides building, so both colours appear.
    expect(srcs.some((s) => s.endsWith("_blue.webp"))).toBe(true);
    expect(srcs.some((s) => s.endsWith("_red.webp"))).toBe(true);
  });
});

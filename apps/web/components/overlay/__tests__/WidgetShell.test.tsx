import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RaceIcon, WidgetHeader, WidgetShell, raceToAccent } from "../WidgetShell";
import { OVERLAY_RACE_COLORS } from "@/lib/overlayRaceColors";
import { OverlayPanel } from "../OverlayPanel";

afterEach(cleanup);

describe("RaceIcon accessible graphic", () => {
  it("keeps the canonical race name when its decorative image falls back", () => {
    const view = render(<RaceIcon race="p" />);
    const graphic = view.getByRole("img", { name: "Race Protoss" });
    const image = graphic.querySelector("img");
    expect(image).not.toBeNull();
    expect(image!.alt).toBe("");
    expect(view.getAllByRole("img")).toHaveLength(1);

    fireEvent.error(image!);
    expect(view.getByRole("img", { name: "Race Protoss" })).toBe(graphic);
    expect(graphic.querySelector("img")).toBeNull();
    expect(graphic.querySelector('[aria-hidden="true"]')?.textContent).toBe("P");
    expect(view.getAllByRole("img")).toHaveLength(1);
  });

  it("names a missing race without exposing its decorative fallback text", () => {
    const view = render(<RaceIcon />);
    const graphic = view.getByRole("img", { name: "Unknown race" });
    expect(graphic.querySelector("img")).toBeNull();
    expect(graphic.querySelector('[aria-hidden="true"]')?.textContent).toBe("?");
    expect(view.getAllByRole("img")).toHaveLength(1);
  });
});

describe("WidgetShell structural theming", () => {
  it.each(Object.entries(OVERLAY_RACE_COLORS))("uses the dark overlay colour for %s", (race, colour) => {
    const { container } = render(<WidgetShell race={race}><RaceIcon race={race} /></WidgetShell>);
    const accent = container.querySelector<HTMLElement>(".widget-shell__accent");
    expect(raceToAccent(race)).toBe(colour);
    expect(accent?.style.background).toContain(colour);
  });

  it("applies scale and frame separately", () => {
    const { container, rerender } = render(<OverlayPanel>Preview</OverlayPanel>);
    const panel = () => container.firstElementChild as HTMLElement;
    expect(panel().style.zoom).toContain("--ov-scale");
    expect(panel().style.clipPath).toContain("--ov-clip");
    expect(panel().querySelector<HTMLElement>(".widget-shell__texture")?.style.background).toContain("--ov-texture");
    expect(panel().querySelector<HTMLElement>(".widget-shell__ornament")?.style.background).toContain("--ov-ornament");
    rerender(<OverlayPanel frame={false}>Preview</OverlayPanel>);
    expect(panel().style.zoom).toContain("--ov-scale");
    expect(panel().style.clipPath).toBe("");
    expect(panel().querySelector(".widget-shell__texture")).toBeNull();
    rerender(<OverlayPanel scale={false} frame={false}>Preview</OverlayPanel>);
    expect(panel().style.zoom).toBe("");
    expect(panel().style.fontFamily).toContain("--ov-font");
  });

  it("keeps shell chrome in named layers for fixed creative styles", () => {
    const { container } = render(
      <WidgetShell accent="cyan">
        <WidgetHeader>Ghost Build</WidgetHeader>
      </WidgetShell>,
    );

    expect(container.querySelector(".widget-shell")).not.toBeNull();
    expect(container.querySelector(".widget-shell__panel")).not.toBeNull();
    expect(container.querySelector(".widget-shell__texture")).not.toBeNull();
    expect(container.querySelector(".widget-shell__ornament")).not.toBeNull();
    expect(container.querySelector(".widget-shell__accent")).not.toBeNull();
    expect(container.querySelector(".widget-shell__content")?.textContent).toBe(
      "Ghost Build",
    );
  });

  it("reads structural values from validated CSS custom properties", () => {
    const { container } = render(
      <WidgetShell accent="magenta">Preview</WidgetShell>,
    );
    const shell = container.querySelector<HTMLElement>(".widget-shell");
    const panel = container.querySelector<HTMLElement>(
      ".widget-shell__panel",
    );
    const accent = container.querySelector<HTMLElement>(
      ".widget-shell__accent",
    );

    expect(shell?.style.boxShadow).toContain("--ov-shell-shadow");
    expect(panel?.style.background).toContain("--ov-panel-bg");
    expect(panel?.style.clipPath).toContain("--ov-clip");
    expect(panel?.style.boxShadow).toBe("");
    expect(panel?.style.flexDirection).toContain("--ov-panel-flow");
    expect(accent?.style.background).toContain("--ov-accent-track");
    expect(accent?.style.flex).toContain("--ov-accent-size");
  });
});

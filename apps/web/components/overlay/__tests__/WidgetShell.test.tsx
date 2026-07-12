import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WidgetHeader, WidgetShell } from "../WidgetShell";

describe("WidgetShell structural theming", () => {
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

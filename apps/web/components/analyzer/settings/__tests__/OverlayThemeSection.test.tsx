import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  OverlayThemePreview,
  OverlayThemeSection,
} from "../OverlayThemeSection";
import { OVERLAY_THEME_PRESETS } from "@/lib/overlayTheme";

// Without this, each render() accumulates in document.body and the
// singular getByRole/getByLabelText queries below throw on duplicate
// matches across tests.
afterEach(cleanup);

/**
 * The preview renders REAL overlay widgets (MatchResult, MmrDelta,
 * Session) with static sample data — no sockets, no useApi, so nothing
 * needs mocking. That's load-bearing: if a future edit wires the
 * preview to live data, these tests start needing socket mocks and the
 * regression becomes visible in review.
 */

describe("OverlayThemePreview", () => {
  it("renders the three sample widgets with static data", () => {
    const { container } = render(<OverlayThemePreview theme={{}} />);
    const text = container.textContent ?? "";
    // MatchResultWidget
    expect(text).toContain("VICTORY");
    expect(text).toContain("Alcyone LE");
    // MmrDeltaWidget
    expect(text).toContain("+18");
    // SessionWidget
    expect(text).toContain("5W");
    expect(text).toContain("2L");
    expect(text).toContain("MMR");
    expect(container.querySelectorAll(".widget-shell")).toHaveLength(3);
  });

  it("applies theme CSS vars to the preview root", () => {
    const { container } = render(
      <OverlayThemePreview
        theme={{ accent: "#ffd166", radius: "pill", scale: 1.25 }}
      />,
    );
    const root = container.querySelector<HTMLElement>(
      '[data-testid="overlay-theme-preview"]',
    );
    expect(root).not.toBeNull();
    expect(root!.style.getPropertyValue("--ov-accent")).toBe("#ffd166");
    expect(root!.style.getPropertyValue("--ov-radius")).toBe("26px");
    expect(root!.style.getPropertyValue("--ov-scale")).toBe("1.25");
  });

  it("sets no --ov-* vars for the default theme (zero-cost path)", () => {
    const { container } = render(<OverlayThemePreview theme={{}} />);
    const root = container.querySelector<HTMLElement>(
      '[data-testid="overlay-theme-preview"]',
    );
    expect(root!.style.getPropertyValue("--ov-accent")).toBe("");
    expect(root!.style.getPropertyValue("--ov-panel-bg")).toBe("");
  });

  it("shows the low-contrast warning chip only for accents under 3:1", () => {
    const dark = render(<OverlayThemePreview theme={{ accent: "#112233" }} />);
    const chip = dark.container.querySelector('[role="status"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("Low contrast");

    const bright = render(
      <OverlayThemePreview theme={{ accent: "#ffd166" }} />,
    );
    expect(bright.container.querySelector('[role="status"]')).toBeNull();

    const none = render(<OverlayThemePreview theme={{}} />);
    expect(none.container.querySelector('[role="status"]')).toBeNull();
  });
});

describe("OverlayThemeSection", () => {
  it("renders a radio card per preset and marks the active one", () => {
    const { getAllByRole, getByRole } = render(
      <OverlayThemeSection theme={{}} onChange={() => {}} />,
    );
    const radios = getAllByRole("radio");
    expect(radios).toHaveLength(OVERLAY_THEME_PRESETS.length);
    expect(
      (getByRole("radio", { name: /default preset/i }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("selecting a preset emits that preset's theme", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <OverlayThemeSection theme={{}} onChange={onChange} />,
    );
    fireEvent.click(getByRole("radio", { name: /retro terminal preset/i }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ font: "mono", radius: "sharp" }),
    );
  });

  it("commits only strict hex from the accent text field", () => {
    const onChange = vi.fn();
    const { getByLabelText } = render(
      <OverlayThemeSection theme={{}} onChange={onChange} />,
    );
    const hexField = getByLabelText("Accent hex value") as HTMLInputElement;

    fireEvent.change(hexField, { target: { value: "#zzz" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(hexField, { target: { value: "#ffd166" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ accent: "#ffd166" }),
    );
  });

  it("normalizes control changes through the strict validator", () => {
    const onChange = vi.fn();
    const { getByLabelText } = render(
      <OverlayThemeSection
        theme={{ radius: "pill" }}
        onChange={onChange}
      />,
    );
    // Picking the default value drops the key entirely rather than
    // storing radius:"rounded".
    fireEvent.change(getByLabelText("Corners"), {
      target: { value: "rounded" },
    });
    expect(onChange).toHaveBeenCalledWith({});
  });
});

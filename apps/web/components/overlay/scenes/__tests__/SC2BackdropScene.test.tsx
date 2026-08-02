/**
 * SC2 backdrop scene — render and data contracts.
 *
 * The visual design is not unit-testable, so these pin down the
 * things that would silently break it on stream:
 *
 *   - the race accent actually follows the live opponent,
 *   - "no data" renders nothing rather than a placeholder,
 *   - both motion off-switches reach the DOM,
 *   - the perf contract (no animated filter / shadow) holds,
 *   - every animation still divides the export loop cleanly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  LOOP_SEC,
  SC2BackdropScene,
  VARIANT_LAYOUT,
  accentForRace,
  formatBackdropCountdown,
  DEFAULT_BACKDROP_ACCENT,
  type BackdropVariant,
} from "../SC2BackdropScene";

afterEach(cleanup);

const ALL_VARIANTS: BackdropVariant[] = [
  "between-games",
  "starting-soon",
  "brb",
  "intermission",
];

describe("accentForRace", () => {
  it("maps each race to its design-system accent", () => {
    expect(accentForRace("Terran")).toBe("#3B82F6");
    expect(accentForRace("Zerg")).toBe("#A855F7");
    expect(accentForRace("Protoss")).toBe("#F59E0B");
    expect(accentForRace("Random")).toBe("#94A3B8");
  });

  it("is case- and whitespace-insensitive", () => {
    // The agent normalises race, but the post-game payload and the
    // live envelope have historically disagreed on casing.
    expect(accentForRace("  zerg ")).toBe("#A855F7");
    expect(accentForRace("PROTOSS")).toBe("#F59E0B");
  });

  it("falls back to the stock accent rather than guessing", () => {
    // A wrong tint mid-match is worse than a neutral one.
    expect(accentForRace(null)).toBe(DEFAULT_BACKDROP_ACCENT);
    expect(accentForRace(undefined)).toBe(DEFAULT_BACKDROP_ACCENT);
    expect(accentForRace("")).toBe(DEFAULT_BACKDROP_ACCENT);
    expect(accentForRace("?")).toBe(DEFAULT_BACKDROP_ACCENT);
  });
});

describe("rendering", () => {
  it("renders every valid variant", () => {
    for (const variant of ALL_VARIANTS) {
      const { container, unmount } = render(
        <SC2BackdropScene variant={variant} />,
      );
      expect(container.querySelector(".sc2bd")).toBeTruthy();
      expect(
        container.querySelector(".sc2bd")?.getAttribute("data-variant"),
      ).toBe(variant);
      unmount();
    }
  });

  it("keeps the between-games centre clear for the sources on top", () => {
    // A webcam and a chat column composite over this one; a headline
    // in the middle would sit behind the streamer's face.
    render(<SC2BackdropScene variant="between-games" />);
    expect(screen.queryByText(/STARTING SOON|BE RIGHT BACK/)).toBeNull();
  });

  it("shows the headline on full-canvas variants", () => {
    render(<SC2BackdropScene variant="brb" />);
    expect(screen.getByText("BE RIGHT BACK")).toBeTruthy();
  });

  it("renders no placeholder when there is no message or countdown", () => {
    const { container } = render(<SC2BackdropScene variant="starting-soon" />);
    expect(screen.getByText("STARTING SOON")).toBeTruthy();
    // No mock data: absent values render nothing at all. Ignore the
    // injected <style> block, which is markup rather than content.
    const visible = [...container.querySelectorAll("*")]
      .filter((el) => el.tagName !== "STYLE" && el.children.length === 0)
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    expect(visible).toEqual(["STARTING SOON"]);
  });

  it("renders a real message and countdown when given them", () => {
    render(
      <SC2BackdropScene
        variant="starting-soon"
        message="grabbing coffee"
        countdownMs={90_000}
      />,
    );
    expect(screen.getByText("grabbing coffee")).toBeTruthy();
    expect(screen.getByText("01:30")).toBeTruthy();
  });

  it("hides an expired countdown instead of showing 00:00 forever", () => {
    render(<SC2BackdropScene variant="brb" countdownMs={0} />);
    expect(screen.queryByText("00:00")).toBeNull();
  });

  it("honours an explicit layout override", () => {
    render(<SC2BackdropScene variant="brb" layout="frame" />);
    expect(screen.queryByText("BE RIGHT BACK")).toBeNull();
  });
});

describe("motion off-switches", () => {
  it("adds the static class when staticMode is set", () => {
    const { container } = render(<SC2BackdropScene staticMode />);
    expect(container.querySelector(".sc2bd-static")).toBeTruthy();
  });

  it("does not add it by default", () => {
    const { container } = render(<SC2BackdropScene />);
    expect(container.querySelector(".sc2bd-static")).toBeNull();
  });

  it("ships a prefers-reduced-motion rule", () => {
    const { container } = render(<SC2BackdropScene />);
    const css = container.querySelector("style")?.textContent ?? "";
    expect(css).toContain("prefers-reduced-motion");
  });
});

describe("performance contract", () => {
  const cssOf = () => {
    const { container } = render(<SC2BackdropScene />);
    return container.querySelector("style")?.textContent ?? "";
  };

  it("only ever animates transform and opacity", () => {
    // Animating filter / box-shadow / text-shadow forces a full
    // repaint every frame and is the biggest CPU sink available to an
    // OBS Browser Source. This backdrop runs for the whole broadcast.
    const css = cssOf();
    const keyframeBodies = css.match(/@keyframes[^{]+\{[\s\S]*?\}\s*\}/g) ?? [];
    expect(keyframeBodies.length).toBeGreaterThan(0);
    for (const body of keyframeBodies) {
      expect(body).not.toMatch(/\bfilter\s*:/);
      expect(body).not.toMatch(/box-shadow\s*:/);
      expect(body).not.toMatch(/text-shadow\s*:/);
    }
  });

  it("keeps every animation duration a clean divisor of the loop", () => {
    // scripts/render-scene.mjs captures exactly one LOOP_SEC cycle; a
    // duration that doesn't divide it makes the MP4 jump at the seam.
    const css = cssOf();
    const durations = [...css.matchAll(/animation[^;]*?([\d.]+)s/g)].map((m) =>
      Number(m[1]),
    );
    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) {
      expect(LOOP_SEC % d, `${d}s does not divide ${LOOP_SEC}s`).toBe(0);
    }
  });

  it("caps the particle count", () => {
    const { container } = render(<SC2BackdropScene />);
    expect(container.querySelectorAll(".sc2bd-mote").length).toBeLessThanOrEqual(
      24,
    );
  });

  it("draws the starfields as two layers, not a node per star", () => {
    const { container } = render(<SC2BackdropScene />);
    expect(container.querySelectorAll(".sc2bd-stars").length).toBe(2);
  });

  it("is deterministic across renders", () => {
    // An unseeded field would reshuffle the sky on every OBS source
    // refresh, which reads as a glitch on stream.
    const a = render(<SC2BackdropScene />).container.innerHTML;
    cleanup();
    const b = render(<SC2BackdropScene />).container.innerHTML;
    expect(a).toBe(b);
  });
});

describe("accent crossfade", () => {
  it("stacks a second layer when the accent changes", () => {
    const { container, rerender } = render(
      <SC2BackdropScene accent="#3B82F6" />,
    );
    expect(container.querySelectorAll(".sc2bd-accent").length).toBe(1);
    rerender(<SC2BackdropScene accent="#A855F7" />);
    expect(container.querySelectorAll(".sc2bd-accent").length).toBe(2);
    expect(container.querySelector(".sc2bd-accent-in")).toBeTruthy();
  });

  it("collapses back to one layer once the fade finishes", () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <SC2BackdropScene accent="#3B82F6" />,
      );
      rerender(<SC2BackdropScene accent="#A855F7" />);
      expect(container.querySelectorAll(".sc2bd-accent").length).toBe(2);
      vi.advanceTimersByTime(1200);
      rerender(<SC2BackdropScene accent="#A855F7" />);
      expect(container.querySelectorAll(".sc2bd-accent").length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restack when the accent is unchanged", () => {
    const { container, rerender } = render(
      <SC2BackdropScene accent="#A855F7" />,
    );
    rerender(<SC2BackdropScene accent="#A855F7" />);
    expect(container.querySelectorAll(".sc2bd-accent").length).toBe(1);
  });
});

describe("formatBackdropCountdown", () => {
  it("formats MM:SS and rolls into hours", () => {
    expect(formatBackdropCountdown(0)).toBe("00:00");
    expect(formatBackdropCountdown(9_000)).toBe("00:09");
    expect(formatBackdropCountdown(90_000)).toBe("01:30");
    expect(formatBackdropCountdown(3_600_000)).toBe("1:00:00");
  });

  it("clamps negatives instead of rendering a minus sign", () => {
    expect(formatBackdropCountdown(-5_000)).toBe("00:00");
  });
});

describe("variant layout table", () => {
  it("covers every variant", () => {
    for (const variant of ALL_VARIANTS) {
      expect(VARIANT_LAYOUT[variant]).toBeDefined();
    }
  });

  it("puts between-games in frame mode", () => {
    // It is the one variant that sits under the webcam, chat column,
    // game inset and stats card the scene builder creates.
    expect(VARIANT_LAYOUT["between-games"]).toBe("frame");
  });
});

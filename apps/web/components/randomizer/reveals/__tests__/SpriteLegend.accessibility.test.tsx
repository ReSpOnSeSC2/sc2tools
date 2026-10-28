import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { contrastRatio } from "@/scripts/contrast-tokens.mjs";
import { SpriteLegend } from "../spriteShared";

afterEach(cleanup);
const build = { id: "oracle", name: "Oracle", race: "Protoss" as const, source: "catalog" as const, weight: 1 };
function rgba(value: string): number[] {
  const channels = value.match(/[\d.]+/g)!.map(Number);
  return [...channels.slice(0, 3), channels[3] ?? 1];
}
function blend(foreground: number[], background: number[], alpha: number): number[] {
  return foreground.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
}

describe("sprite legend text contrast", () => {
  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])("keeps readable labels for eliminated=%s, highlighted=%s while fading only the eliminated icon", (out, highlighted) => {
    render(<SpriteLegend pool={[build]} sprites={new Map()} eliminated={new Set(out ? [build.id] : [])} highlightId={highlighted ? build.id : null} />);
    const label = screen.getByText("Oracle"), pill = label.parentElement!;
    const icon = pill.firstElementChild as HTMLElement;
    expect(pill.style.textDecoration).toBe(out ? "line-through" : "none");
    expect(Number(pill.style.opacity || 1)).toBe(1);
    expect(Number(label.style.opacity || 1)).toBe(1);
    expect(Number(icon.style.opacity)).toBe(out ? 0.55 : 1);

    // Read the actual component colours and alpha, including highlight fill.
    // These are the dark arena surfaces; the full browser AA scan remains the
    // authority for the rendered page and any other ancestor compositing.
    const fill = rgba(pill.style.background), ink = rgba(pill.style.color);
    for (const panel of [[14, 16, 23], [11, 13, 18]]) {
      const background = blend(fill, panel, fill[3]);
      expect(contrastRatio(blend(ink, background, ink[3]), background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

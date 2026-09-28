/**
 * PlayerChooser — one-tap candidates, "None of these", focus + live region.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MeCandidate } from "@/lib/instant/meDetection";
import { PlayerChooser, candidateLabel } from "../PlayerChooser";

const CANDIDATES: MeCandidate[] = [
  { toon: "1-S2-1-111", name: "Rex", race: "Zerg", games: 4 },
  { toon: "1-S2-1-222", name: "Nova", race: "Terran", games: 1 },
];

afterEach(cleanup);

describe("PlayerChooser", () => {
  it("renders one button per candidate and reports the chosen toon", () => {
    const onChoose = vi.fn();
    render(<PlayerChooser candidates={CANDIDATES} onChoose={onChoose} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Rex · Zerg · 4 games" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Nova · Terran · 1 game" }));
    expect(onChoose).toHaveBeenCalledWith("1-S2-1-222");
  });

  it("cancels with None of these", () => {
    const onCancel = vi.fn();
    render(<PlayerChooser candidates={CANDIDATES} onChoose={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "None of these" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("focuses the question inside a polite live region", () => {
    render(<PlayerChooser candidates={CANDIDATES} onChoose={vi.fn()} onCancel={vi.fn()} />);
    const heading = screen.getByRole("heading", { name: "Which player are you?" });
    expect(document.activeElement).toBe(heading);
    expect(heading.closest("[aria-live='polite']")).not.toBeNull();
  });

  it("labels unnamed and race-less candidates sensibly", () => {
    expect(candidateLabel({ toon: "t", name: "", race: "", games: 2 })).toBe("Unnamed player · 2 games");
  });
});

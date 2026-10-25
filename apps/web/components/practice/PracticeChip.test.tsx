import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PracticeChip } from "./PracticeChip";
import type { GhostBuildConfig } from "@/lib/ghostBuild";
const target = { v: 1 as const, name: "Blink", steps: [{ supply: null, t: 30, name: "Gateway" }] };
const h = vi.hoisted(() => ({ owner: "a" as string | null, config: { v: 2, slots: {} } as GhostBuildConfig, assign: vi.fn() }));
vi.mock("@/lib/useGhostPractice", () => ({ useGhostPractice: () => ({ ...h, saving: false, loading: false }) }));
afterEach(() => { cleanup(); h.assign.mockReset(); h.owner = "a"; h.config = { v: 2, slots: {} }; });
describe("app practice chip", () => {
  it("shows an honest extra-slot count and disarms only the displayed snapshot", () => {
    h.config = { v: 2, slots: { PvT: target, PvZ: target } }; render(<PracticeChip />);
    expect(screen.getByRole("link").textContent).toBe("Practicing: Blink (PvT) · +1");
    fireEvent.click(screen.getByRole("button", { name: "Disarm PvT practice" })); expect(h.assign).toHaveBeenCalledWith("PvT", null, target);
  });
  it("renders nothing without assignments or an authenticated owner", () => {
    const view = render(<PracticeChip />); expect(view.container.textContent).toBe("");
    h.config = { v: 2, slots: { PvT: target } }; h.owner = null; view.rerender(<PracticeChip />); expect(view.container.textContent).toBe("");
  });
});

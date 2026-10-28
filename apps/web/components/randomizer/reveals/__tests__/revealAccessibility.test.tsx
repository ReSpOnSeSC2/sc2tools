import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rarityFor, RevealKeyframes, useReducedMotion, WinnerCard } from "../revealShared";
import { GachaSummonReveal } from "../GachaSummonReveal";

vi.mock("../revealSound", () => ({ useRevealSound: () => {} }));
const winner = { id: "blink", name: "Blink", race: "Protoss" as const, source: "catalog" as const, weight: 1 };
let osReduced = false;
const listeners = new Set<() => void>();
const removeListener = vi.fn((_: string, listener: () => void) => listeners.delete(listener));
beforeEach(() => {
  osReduced = false; listeners.clear(); removeListener.mockClear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return osReduced; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: removeListener,
  })));
});
afterEach(() => { cleanup(); document.documentElement.removeAttribute("data-motion"); vi.useRealTimers(); vi.unstubAllGlobals(); });
function MotionProbe() { return <output>{useReducedMotion() ? "reduced" : "full"}</output>; }

describe("randomizer motion preference", () => {
  it("combines live OS and page preferences without overriding device reduction", async () => {
    const view = render(<MotionProbe />);
    expect(screen.getByRole("status").textContent).toBe("full");
    await act(async () => { document.documentElement.dataset.motion = "reduce"; });
    expect(screen.getByRole("status").textContent).toBe("reduced");
    act(() => { osReduced = true; listeners.forEach(listener => listener()); });
    await act(async () => { document.documentElement.dataset.motion = "full"; });
    expect(screen.getByRole("status").textContent).toBe("reduced");
    act(() => { osReduced = false; listeners.forEach(listener => listener()); });
    expect(screen.getByRole("status").textContent).toBe("full");
    view.unmount(); expect(removeListener).toHaveBeenCalledTimes(1); expect(listeners.size).toBe(0);
  });

  it("honours page reduction when matchMedia is unavailable", async () => {
    vi.stubGlobal("matchMedia", undefined);
    document.documentElement.dataset.motion = "reduce";
    render(<MotionProbe />);
    expect(screen.getByRole("status").textContent).toBe("reduced");
    await act(async () => { document.documentElement.removeAttribute("data-motion"); });
    expect(screen.getByRole("status").textContent).toBe("full");
  });
});

describe("winner motion", () => {
  it("uses only a 200ms opacity transition without zoom, pulse, spring or confetti when reduced", () => {
    const { container } = render(<WinnerCard winner={winner} rarity={rarityFor(0.25)} show reducedMotion />);
    const card = container.querySelector<HTMLElement>(".rdz-winner")!;
    expect(card.style.transition).toBe("opacity 200ms ease");
    expect(card.style.transform).toBe("translate(-50%, -50%)");
    expect(container.querySelector<HTMLElement>(".rdz-winzoom")!.style.animation).toBe("none");
    expect(container.querySelector<HTMLElement>(".rdz-pulse")!.style.animation).toBe("none");
    expect(container.querySelector(".rdz-confetti")).toBeNull();
  });

  it("keeps the established nonreduced reveal and OBS animation", () => {
    const { container } = render(<WinnerCard winner={winner} rarity={rarityFor(0.25)} show reducedMotion={false} />);
    expect(container.querySelector<HTMLElement>(".rdz-winner")!.style.transition).toContain("transform 360ms cubic-bezier(.34,1.8,.5,1)");
    expect(container.querySelector<HTMLElement>(".rdz-winzoom")!.style.animation).toContain("rdz-winzoom");
    expect(container.querySelector<HTMLElement>(".rdz-pulse")!.style.animation).toContain("infinite");
    expect(container.querySelectorAll(".rdz-confetti")).toHaveLength(14);
  });

  it("disables all named animations and confetti in both CSS preference fallbacks", () => {
    const { container } = render(<RevealKeyframes />);
    const css = container.querySelector("style")!.textContent!;
    const os = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"), css.indexOf('[data-motion="reduce"]'));
    expect(os).toContain(".rdz-frame * { transition: none !important; }");
    expect(os).toContain(".rdz-pulse, .rdz-winzoom, .rdz-charge { animation: none !important; }");
    expect(os).toContain(".rdz-confetti { animation: none !important; opacity: 0 !important; }");
    for (const name of ["pulse", "winzoom", "charge", "confetti"]) expect(css).toContain(`[data-motion="reduce"] .rdz-${name}`);
    const page = css.slice(css.indexOf('[data-motion="reduce"]'));
    expect(page).toContain('[data-motion="reduce"] .rdz-frame * { transition: none !important; }');
    expect(page).toContain(".rdz-charge { animation: none !important; }");
    expect(page).toContain(".rdz-confetti { animation: none !important; opacity: 0 !important; }");
    expect(os).toContain("transition: opacity 200ms ease !important"); expect(page).toContain("transition: opacity 200ms ease !important");
  });

  it.each(["os", "page"])("settles Gacha once without charging pulse or beams motion for %s reduction", (preference) => {
    vi.useFakeTimers();
    if (preference === "os") osReduced = true;
    else document.documentElement.dataset.motion = "reduce";
    const complete = vi.fn();
    const { container } = render(<GachaSummonReveal pool={[winner]} probabilities={[1]} winner={winner} winnerProbability={1} spinId={1} matchupLabel="PvT" onComplete={complete} />);
    expect(container.querySelector<HTMLElement>(".rdz-charge")!.style.animation).toBe("none");
    act(() => vi.runOnlyPendingTimers());
    expect(complete).toHaveBeenCalledTimes(1); expect(container.querySelector(".rdz-charge")).toBeNull();
    expect(container.querySelector<HTMLElement>(".rdz-winner")!.style.transition).toBe("opacity 200ms ease");
    expect([...container.querySelectorAll<HTMLElement>("[style]")].some(node => /infinite|rdz-beam/.test(node.style.animation))).toBe(false);
    expect(container.querySelector(".rdz-confetti")).toBeNull();
  });
});

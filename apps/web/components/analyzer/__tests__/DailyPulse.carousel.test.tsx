import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DailyPulse } from "../DailyPulse";
import { dailyPulseHref } from "@/lib/dailyPulseNavigation";
const cards = vi.hoisted(() => [
  { id: "build", category: "build", tone: "positive", kicker: "Build", title: "Rising build", body: "Recorded result", targetTab: "builds", targetQuery: { q: "Forge expand" } },
  { id: "map", category: "map", tone: "positive", kicker: "Map", title: "Map edge", body: "Recorded result", targetTab: "battlefield", targetQuery: { focus: "Sanctuary III LE" } },
  { id: "opponent", category: "opponent", tone: "warning", kicker: "Opponent", title: "Nemesis", body: "Recorded result", targetTab: "opponents", targetQuery: { pulseId: "1-S2-1-42" } },
  { id: "streak", category: "streak", tone: "accent", kicker: "Streak", title: "Winning streak", body: "Recorded result", targetTab: "trends" },
]);
vi.mock("@/lib/dailyPulse", () => ({ selectDailyPulse: () => ({ cards }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: null }) }));
vi.mock("@/components/analyzer/arcade/hooks/useDailySeed", () => ({ useDailySeed: () => ({ day: "2026-10-25", userId: "fixture", tz: "UTC" }) }));
vi.mock("@/components/analyzer/arcade/hooks/useAnalysisGames", () => ({ useAnalysisGames: () => ({ items: [], isActive: true, isLoading: false, syncedAt: null, onDevice: false, keepFailed: false, load: () => {}, keepOnDevice: () => {}, release: () => {} }) }));
let observed: Element[], emit: IntersectionObserverCallback, disconnect: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window.localStorage.clear(); observed = []; disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { emit = callback; } observe(el: Element) { observed.push(el); } disconnect = disconnect; });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("updates live position through IntersectionObserver and scrolls one card with reduced motion and keyboard", async () => {
  render(<DailyPulse hrefForCard={card => dailyPulseHref(card, "filters=1&race=P")} />);
  const root = await screen.findByRole("region", { name: "Daily Pulse insights" });
  Object.defineProperties(root, { clientWidth: { value: 500 }, scrollWidth: { value: 1168 } });
  const scrollTo = vi.fn(({ left }: ScrollToOptions) => { root.scrollLeft = Math.min(668, left ?? 0); fireEvent.scroll(root); }); Object.defineProperty(root, "scrollTo", { value: scrollTo, configurable: true });
  observed.forEach((el, index) => { Object.defineProperty(el, "offsetLeft", { value: index * 292 }); el.getBoundingClientRect = () => ({ left: index * 292 - root.scrollLeft }) as DOMRect; });
  const intersect = (ratios: number[]) => act(() => emit(observed.map((target, index) => ({ target, intersectionRatio: ratios[index] })) as IntersectionObserverEntry[], {} as IntersectionObserver));
  intersect([1, .5, 0, 0]);
  expect(screen.getByText("1 of 4").getAttribute("aria-live")).toBe("polite");
  const prev = screen.getByRole("button", { name: "Previous insight" }), next = screen.getByRole("button", { name: "Next insight" });
  expect(prev).toHaveProperty("disabled", true); expect(next).toHaveProperty("disabled", false);
  fireEvent.click(next); expect(scrollTo).toHaveBeenLastCalledWith({ left: 292, behavior: "auto" });
  intersect([0, 1, .5, 0]); expect(screen.getByText("2 of 4")).toBeTruthy(); expect(prev).toHaveProperty("disabled", false);
  root.focus(); fireEvent.keyDown(root, { key: "ArrowRight" }); expect(scrollTo).toHaveBeenLastCalledWith({ left: 584, behavior: "auto" });
  fireEvent.keyDown(root, { key: "ArrowRight" }); expect(next).toHaveProperty("disabled", true);
  fireEvent.keyDown(root, { key: "ArrowLeft" }); expect(scrollTo).toHaveBeenLastCalledWith({ left: 376, behavior: "auto" });
  cleanup(); expect(disconnect).toHaveBeenCalled();
});

it("renders real contextual links with focus rings and leaves card keyboard events alone", async () => {
  render(<DailyPulse hrefForCard={card => dailyPulseHref(card, "filters=1&race=P")} />);
  const build = await screen.findByRole("link", { name: /Rising build/ });
  expect(build.getAttribute("href")).toBe("/app/builds?filters=1&race=P&q=Forge+expand");
  expect(build.className).toContain("focus-visible:ring-2");
  expect(screen.getByRole("link", { name: /Map edge/ }).getAttribute("href")).toContain("focus=Sanctuary+III+LE");
  expect(screen.getByRole("link", { name: /Nemesis/ }).getAttribute("href")).toBe("/app/opponents/1-S2-1-42?filters=1&race=P");
  const root = screen.getByRole("region", { name: "Daily Pulse insights" }); root.scrollTo = vi.fn();
  fireEvent.keyDown(build, { key: "ArrowRight" }); expect(root.scrollTo).not.toHaveBeenCalled();
});

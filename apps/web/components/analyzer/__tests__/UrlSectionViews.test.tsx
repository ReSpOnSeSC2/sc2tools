import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const route = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prior: "", staleSearch: null as string | null }));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (notify: () => void) => { window.addEventListener("fixture-navigation", notify); window.addEventListener("popstate", notify); return () => { window.removeEventListener("fixture-navigation", notify); window.removeEventListener("popstate", notify); }; };
  return { useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => route.staleSearch ?? window.location.search, () => "")), usePathname: () => useSyncExternalStore(subscribe, () => window.location.pathname, () => ""), useRouter: () => route };
});
vi.mock("../StrategiesTab", () => ({ StrategiesTab: ({ drill, onDrillChange, view, onViewChange }: any) => <><output aria-label="View">{view}</output><button onClick={() => onViewChange("bvs")}>Matrix view</button><button onClick={() => onViewChange("opp")}>Opponent view</button><button onClick={() => onDrillChange({ build: "Gateway", opp_strategy: "Pressure", opp_race: "Z" })}>Open pair</button>{drill ? <div role="dialog" aria-label="Strategy games"><output>{JSON.stringify(drill)}</output><button onClick={() => onDrillChange(null)}>Close games</button></div> : null}</> }));
vi.mock("../BuildsTab", () => ({ BuildsTab: ({ search, onSearchChange }: any) => <input aria-label="Build search" value={search} onChange={event => onSearchChange(event.target.value)} /> }));
vi.mock("../ArcadeTab", () => ({ ArcadeTab: ({ sub, onSubChange }: any) => <><output aria-label="Arcade tab">{sub}</output><button onClick={() => onSubChange("quick-play")}>Quick play</button></> }));
vi.mock("../BattlefieldTab", () => ({ BattlefieldTab: ({ focus }: any) => <output aria-label="Map focus">{focus}</output> }));
import { StrategiesUrlView } from "../StrategiesUrlView";
import { BuildsUrlView } from "../BuildsUrlView";
import { ArcadeUrlView } from "../ArcadeUrlView";
import { MapsUrlView } from "../MapsUrlView";
import { useOpponentUrlControls } from "../useOpponentUrlControls";
function navigate(href: string, event = "fixture-navigation", state: unknown = null) { window.history.replaceState(state, "", href); window.dispatchEvent(new Event(event)); }
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); route.staleSearch = null; route.push.mockReset(); route.replace.mockReset(); route.back.mockReset();
  route.push.mockImplementation(href => { route.prior = `${window.location.pathname}${window.location.search}`; navigate(href, "fixture-navigation", { next: true }); });
  // Next replaces its own history object and drops custom fields by default.
  route.replace.mockImplementation(href => navigate(href, "fixture-navigation", { next: true }));
  route.back.mockImplementation(() => navigate(route.prior, "popstate"));
  navigate("/app/strategies?filters=1&race=P", "popstate");
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("pushes exactly one drill entry and Back closes an owned sheet, including after a remount", () => {
  const view = render(<StrategiesUrlView />);
  fireEvent.click(screen.getByRole("button", { name: "Open pair" }));
  expect(route.push).toHaveBeenCalledTimes(1); expect(screen.getByRole("dialog").textContent).toContain('"opp_race":"Z"');
  expect(new URLSearchParams(window.location.search).get("race")).toBe("P");
  const marker = window.history.state.sc2toolsStrategyDrill;
  fireEvent.click(screen.getByRole("button", { name: "Opponent view" }));
  expect(route.replace).toHaveBeenCalledTimes(1); expect(window.history.state.sc2toolsStrategyDrill).toBe(marker);
  view.unmount(); render(<StrategiesUrlView />);
  fireEvent.click(screen.getByRole("button", { name: "Close games" }));
  expect(route.back).toHaveBeenCalledTimes(1); expect(screen.queryByRole("dialog")).toBeNull();
  expect(window.location.search).toBe("?filters=1&race=P");
});
it("closes a copied drill with replace and reads view from URL before device preference", () => {
  localStorage.setItem("analyzer.strategies.view", JSON.stringify("bvs"));
  navigate("/app/strategies?view=opp&drill=strategy%3A12+Pool", "popstate");
  render(<StrategiesUrlView />); expect(screen.getByLabelText("View").textContent).toBe("opp");
  fireEvent.click(screen.getByRole("button", { name: "Close games" }));
  expect(route.back).not.toHaveBeenCalled(); expect(route.push).not.toHaveBeenCalled(); expect(route.replace).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Matrix view" }));
  expect(new URLSearchParams(window.location.search).has("view")).toBe(false);
});
it("never stamps a delayed owned acknowledgement onto a newer external address", () => {
  const view = render(<StrategiesUrlView />);
  fireEvent.click(screen.getByRole("button", { name: "Open pair" }));
  route.replace.mockImplementation(href => {
    const external = new URL(href, window.location.origin); external.searchParams.set("map", "External cohort");
    route.staleSearch = new URL(href, window.location.origin).search;
    navigate(`${external.pathname}${external.search}`, "fixture-navigation", { next: true });
  });
  fireEvent.click(screen.getByRole("button", { name: "Opponent view" }));
  expect(window.history.state.sc2toolsStrategyDrill).toBeUndefined();
  view.unmount(); route.staleSearch = null;
  route.replace.mockImplementation(href => navigate(href, "fixture-navigation", { next: true }));
  render(<StrategiesUrlView />); fireEvent.click(screen.getByRole("button", { name: "Close games" }));
  expect(route.back).not.toHaveBeenCalled(); expect(window.location.search).toContain("map=External+cohort");
});
it("does not claim a copied same-drill address ahead of the first push acknowledgement", () => {
  route.push.mockImplementation(href => {
    route.staleSearch = new URL(href, window.location.origin).search;
    const external = new URL(href, window.location.origin); external.searchParams.set("map", "Different incoming cohort");
    navigate(`${external.pathname}${external.search}`, "fixture-navigation", { next: true });
  });
  const view = render(<StrategiesUrlView />); fireEvent.click(screen.getByRole("button", { name: "Open pair" }));
  expect(window.history.state.sc2toolsStrategyDrill).toBeUndefined(); view.unmount(); route.staleSearch = null;
  render(<StrategiesUrlView />); fireEvent.click(screen.getByRole("button", { name: "Close games" }));
  expect(route.back).not.toHaveBeenCalled(); expect(window.location.search).toContain("map=Different+incoming+cohort");
});
it("keeps a build search in its URL and takes Back before a queued draft", () => {
  vi.useFakeTimers(); navigate("/app/builds?q=Gateway", "popstate"); render(<BuildsUrlView />);
  const input = screen.getByRole("textbox", { name: "Build search" }) as HTMLInputElement; expect(input.value).toBe("Gateway");
  fireEvent.change(input, { target: { value: "Blink" } }); expect(input.value).toBe("Blink");
  act(() => navigate("/app/builds?q=Pool", "popstate"));
  act(() => { vi.advanceTimersByTime(400); }); expect(input.value).toBe("Pool"); expect(route.replace).not.toHaveBeenCalled();
});
it("uses section-only Arcade and Maps query keys and updates on router navigation", () => {
  navigate("/app/arcade?tab=collection", "popstate"); const arcade = render(<ArcadeUrlView />);
  expect(screen.getByLabelText("Arcade tab").textContent).toBe("collection"); fireEvent.click(screen.getByRole("button", { name: "Quick play" }));
  expect(window.location.search).toContain("tab=quick-play"); arcade.unmount();
  navigate("/app/maps?focus=Ancient+Cistern&map=Ruby+Rock", "popstate"); render(<MapsUrlView />);
  expect(screen.getByLabelText("Map focus").textContent).toBe("Ancient Cistern");
  act(() => navigate("/app/maps?focus=New+map&map=Ruby+Rock"));
  expect(screen.getByLabelText("Map focus").textContent).toBe("New map"); expect(new URLSearchParams(window.location.search).get("map")).toBe("Ruby Rock");
});
it("keeps Opponents URL sort above storage, debounces search without losing an intervening sort, and accepts Back", () => {
  vi.useFakeTimers();
  localStorage.setItem("analyzer.opponents.sort", JSON.stringify({ sortBy: "games", sortDir: "desc" }));
  navigate("/app/opponents?q=Alpha&sort=name%3Aasc&impact=tracked", "popstate");
  const { result } = renderHook(() => useOpponentUrlControls());
  expect(result.current.sort.sortBy).toBe("name"); expect(result.current.sort.sortDir).toBe("asc"); expect(result.current.impact).toBe("tracked");
  act(() => result.current.setSearch("Beta"));
  act(() => result.current.sort.setSortExplicit("netMmr", "desc"));
  expect(result.current.search).toBe("Beta");
  act(() => { vi.advanceTimersByTime(300); });
  const params = new URLSearchParams(window.location.search);
  expect(params.get("q")).toBe("Beta"); expect(params.get("sort")).toBe("netMmr:desc");
  expect(JSON.parse(localStorage.getItem("analyzer.opponents.sort")!)).toEqual({ sortBy: "netMmr", sortDir: "desc" });
  act(() => navigate("/app/opponents?q=Alpha&sort=wins%3Aasc&notes=1", "popstate"));
  expect(result.current.search).toBe("Alpha"); expect(result.current.sort.sortBy).toBe("wins"); expect(result.current.sort.sortDir).toBe("asc"); expect(result.current.hasNotes).toBe(true);
});

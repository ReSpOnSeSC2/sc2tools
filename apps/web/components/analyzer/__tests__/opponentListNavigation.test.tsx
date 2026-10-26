import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readOpponentListQuery, storedOpponentListUrl, useOpponentListNavigation, writeOpponentListQuery } from "../useOpponentListNavigation";
import { RevealedChip } from "../RevealedChip";
import { StrictMode, type ReactNode } from "react";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState({}, "", "/app/opponents"); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const route = (query: string) => ({ pathname: "/app/opponents", query, replace: vi.fn(), navigate: vi.fn(), prefetch: vi.fn() });

it("reads explicit URL state over storage and debounces only the query while preserving unknown parameters", () => {
  vi.useFakeTimers();
  localStorage.setItem("analyzer.opponents.sort", JSON.stringify({ sortBy: "games", sortDir: "desc" }));
  const location = route("q=Alpha&sort=name&dir=asc&impact=tracked&notes=1&future=keep");
  const { result } = renderHook(() => useOpponentListNavigation(location));
  expect(result.current.search).toBe("Alpha"); expect(result.current.sort.sortBy).toBe("name"); expect(result.current.sort.sortDir).toBe("asc"); expect(result.current.hasNotes).toBe(true);
  act(() => result.current.setSearch("Beta"));
  act(() => vi.advanceTimersByTime(299)); expect(location.replace).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(location.replace).toHaveBeenLastCalledWith("/app/opponents?q=Beta&sort=name%3Aasc&impact=tracked&notes=1&future=keep");
  act(() => result.current.sort.setSortExplicit("wins", "desc"));
  expect(location.replace).toHaveBeenLastCalledWith("/app/opponents?q=Beta&sort=wins%3Adesc&impact=tracked&notes=1&future=keep");
  expect(JSON.parse(localStorage.getItem("analyzer.opponents.sort")!)).toEqual({ sortBy: "wins", sortDir: "desc" });
});
it("applies browser Back URL state without briefly rewriting it with the previous controls", () => {
  vi.useFakeTimers();
  const first = route("q=Alpha&sort=name");
  const { result, rerender } = renderHook(({ location }) => useOpponentListNavigation(location), { initialProps: { location: first } });
  const back = route("q=Beta&sort=games&dir=asc&notes=1");
  rerender({ location: back });
  expect(result.current.search).toBe("Beta"); expect(result.current.sort.sortBy).toBe("games"); expect(result.current.hasNotes).toBe(true);
  expect(back.replace).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(300)); expect(back.replace).not.toHaveBeenCalled();
});
it("keeps URL hydration and Back read-only while intentional external setters persist in StrictMode", () => {
  vi.useFakeTimers();
  const saved = { sortBy: "games", sortDir: "asc" };
  const key = "analyzer.opponents.sort";
  localStorage.setItem(key, JSON.stringify(saved));
  const first = route("sort=name&dir=desc");
  const { result, rerender, unmount } = renderHook(({ location }) => useOpponentListNavigation(location), {
    initialProps: { location: first }, wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  });
  expect(result.current.sort.sortBy).toBe("name");
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(saved);
  const back = route("sort=lastPlayed&dir=asc");
  rerender({ location: back });
  expect(result.current.sort.sortBy).toBe("lastPlayed");
  expect(result.current.sort.sortDir).toBe("asc");
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(saved);
  expect(back.replace).not.toHaveBeenCalled();
  act(() => result.current.sort.setSortExplicit("wins", "desc"));
  unmount();
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ sortBy: "wins", sortDir: "desc" });
});
it("flushes a pending search into the history entry and saves the exact render window before a dossier opens", () => {
  const location = route("future=keep");
  const { result } = renderHook(() => useOpponentListNavigation(location));
  act(() => result.current.setSearch("Still typing"));
  act(() => result.current.remember({ renderWindow: 600, expandedGroups: ["123"] }));
  const stored = JSON.parse(sessionStorage.getItem("opponents:list-state")!);
  expect(stored.listUrl).toBe("/app/opponents?future=keep&q=Still+typing"); expect(stored.renderWindow).toBe(600); expect(stored.expandedGroups).toEqual(["123"]);
  expect(window.location.search).toBe("?future=keep&q=Still+typing"); expect(sessionStorage.getItem("opponents:from-list")).toBe("1");
});
it("omits defaults and ignores invalid URL enum values without removing future parameters", () => {
  expect(writeOpponentListQuery("q=gone&sort=bad&dir=bad&impact=bad&notes=0&future=keep", readOpponentListQuery(""))).toBe("future=keep");
  expect(readOpponentListQuery("sort=invalid&dir=invalid&impact=invalid")).toEqual(readOpponentListQuery(""));
  for (const listUrl of ["https://elsewhere.example/app/opponents?q=x", "/app/settings"]) {
    sessionStorage.setItem("opponents:list-state", JSON.stringify({ listUrl })); expect(storedOpponentListUrl()).toBe("/app/opponents");
  }
});
it.each(["region", "lastResult", "lastGameLength", "avgGameLength", "map", "myBuild", "opponentBuild", "macroBreakdown", "avgMacroScore", "buildOrderDate"])("retains the added %s column sort in canonical and legacy list URLs", column => {
  for (const query of [`sort=${column}%3Aasc`, `sort=${column}&dir=asc`]) {
    const state = readOpponentListQuery(query);
    expect(state.sort).toBe(column); expect(state.dir).toBe("asc");
    expect(writeOpponentListQuery("future=keep&dir=desc", state)).toBe(`future=keep&sort=${column}%3Aasc`);
  }
});
it("renders shared revealed chips at both sizes without calling an unverified Pulse label confirmed", () => {
  render(<><RevealedChip name="Serral" size="sm" confirmed /><RevealedChip name="Harstem" size="md" /><RevealedChip name="Serral" displayedName="Serral" confirmed /></>);
  expect(screen.getByTitle("Confirmed by an admin").textContent).toBe("Confirmed as Serral");
  expect(screen.getByTitle("Revealed on SC2Pulse").textContent).toBe("Revealed as Harstem");
  expect(screen.getAllByText(/Serral/)).toHaveLength(1);
});

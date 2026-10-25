import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameNavigation, ownerNeighborPath } from "../GameNavigation";
import { gameSourceFromQuery, previousEntryMatchesSource, safeGameSource } from "@/lib/gameNavigation";
import { gameAnalysisHref } from "@/lib/opponentNavigation";
import { GameAnalysisLink, GameSourceLabelProvider } from "../../GameAnalysisLink";
import { OpponentLink } from "../../OpponentLink";
import { gameSourceFilters } from "@/lib/gameSourceFilters";

const state = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn(), mutate: vi.fn(), path: "", loading: false, previous: false, error: false, data: { prev: { gameId: "older/id", map: "Old map" }, next: { gameId: "newer", map: "New map" }, h2h: { wins: 3, losses: 2 } } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push, prefetch: state.prefetch }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string) => {
  state.path = path; return { data: state.data, isPreviousData: state.previous, error: state.error ? { status: 503 } : undefined, isLoading: state.loading, mutate: state.mutate };
} }));
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); state.previous = false; state.error = false; state.loading = false; window.history.replaceState(null, "", "/"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("owner game navigation", () => {
  it("defaults opponent entries to that opponent, preserves source filters, prefetches next and shows recorded H2H", () => {
    const source = safeGameSource("/app/replays?race=P&map=Blackrock&tab=replays#recent")!;
    render(<GameNavigation game={{ gameId: "current" }} source={source} opponentContext={{ pulseId: "123", displayName: "Player" }} />);
    expect(state.path).toBe("/v1/games/current/neighbors?scope=opponent&race=P&map=Blackrock");
    const older = screen.getByRole("link", { name: "‹ Older" }).getAttribute("href")!;
    const query = new URL(older, "https://example.test"); expect(query.pathname).toBe("/app/game/older%2Fid"); expect(query.searchParams.get("from")).toBe(source.href); expect(query.searchParams.get("opponent")).toBe("123");
    expect(state.prefetch).toHaveBeenCalledWith(screen.getByRole("link", { name: "Newer ›" }).getAttribute("href"));
    expect(screen.getByText("H2H 3–2 all-time")).toBeTruthy();
  });

  it("remembers scope and refuses to navigate using stale scope data", () => {
    localStorage.setItem("sc2tools:game-neighbor-scope:v1", "build");
    const view = render(<GameNavigation game={{ gameId: "one" }} />);
    expect(state.path).toContain("scope=build");
    fireEvent.change(screen.getByRole("combobox", { name: "Games to step through" }), { target: { value: "matchup" } });
    expect(localStorage.getItem("sc2tools:game-neighbor-scope:v1")).toBe("matchup");
    state.previous = true; view.rerender(<GameNavigation game={{ gameId: "one" }} />);
    expect(screen.queryByRole("link", { name: "‹ Older" })).toBeNull();
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true }); expect(state.push).not.toHaveBeenCalled();
    state.previous = false; state.error = true; view.rerender(<GameNavigation game={{ gameId: "one" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(state.mutate).toHaveBeenCalledOnce();
  });

  it("uses Alt arrows outside typing fields and modals", () => {
    render(<><GameNavigation game={{ gameId: "one" }} /><input aria-label="Notes" /></>);
    fireEvent.keyDown(document.body, { key: "ArrowLeft", altKey: true }); expect(state.push).toHaveBeenCalledWith("/app/game/older%2Fid");
    state.push.mockClear(); fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowRight", altKey: true }); expect(state.push).not.toHaveBeenCalled();
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); document.body.append(dialog);
    fireEvent.keyDown(document.body, { key: "ArrowRight", altKey: true }); expect(state.push).not.toHaveBeenCalled(); dialog.remove();
  });

  it("carries the actual list URL and updated filters without breaking link propagation", () => {
    window.history.replaceState(null, "", "/app?tab=macro&since=2026-10-01#leaks");
    const view = render(<GameSourceLabelProvider label="PvZ – Archon Drop"><GameAnalysisLink gameId="one">Open game</GameAnalysisLink></GameSourceLabelProvider>);
    expect(new URL(screen.getByRole("link").getAttribute("href")!, "https://example.test").searchParams.get("fromLabel")).toBe("PvZ – Archon Drop");
    expect(new URL(screen.getByRole("link").getAttribute("href")!, "https://example.test").searchParams.get("from")).toBe("/app?tab=macro&since=2026-10-01#leaks");
    window.history.replaceState(null, "", "/app?tab=macro&race=Z"); view.rerender(<GameAnalysisLink gameId="one">Open game</GameAnalysisLink>);
    expect(new URL(screen.getByRole("link").getAttribute("href")!, "https://example.test").searchParams.get("from")).toBe("/app?tab=macro&race=Z");
  });

  it("keeps unknown identities as text and stops a dossier link expanding its row", () => {
    const expand = vi.fn(); const view = render(<div onClick={expand}><OpponentLink name="Known" pulseId="123" /></div>);
    fireEvent.click(screen.getByRole("link")); expect(expand).not.toHaveBeenCalled(); view.unmount();
    render(<OpponentLink name="Unknown" />); expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("durable game sources", () => {
  it("a replacement cohort excludes both global and incoming URL dates while retaining the durable Back URL", () => {
    const original = "/app/opponents/123?since=2026-10-01&until=2026-10-24&map=Old";
    window.history.replaceState(null, "", original);
    render(<GameSourceLabelProvider label="Opponent history" filters="race=P&map=New" replace><GameSourceLabelProvider label="Opponent history" filters="result=loss"><GameAnalysisLink gameId="one">Open scoped game</GameAnalysisLink></GameSourceLabelProvider></GameSourceLabelProvider>);
    const query = new URL(screen.getByRole("link", { name: "Open scoped game" }).getAttribute("href")!, "https://example.test").searchParams;
    expect(query.get("from")).toBe(original);
    expect(new URLSearchParams(query.get("fromFilters")!)).toEqual(new URLSearchParams("race=P&map=New&result=loss"));
  });
  it("bounds filter snapshots, omits credentials and pagination, and preserves them across neighbor links", () => {
    expect(gameSourceFilters("race=P&search=Rival&cursor=private&token=secret&limit=25&scope=opponent", "race=T&result=loss")).toBe("race=T&q=Rival&result=loss");
    expect(gameSourceFilters(`q=${"x".repeat(257)}&map=ok`)).toBe("map=ok");
    expect(gameSourceFilters("q=bad%00value&build=ok")).toBe("build=ok");
    expect(gameSourceFilters("x".repeat(4097))).toBe("");
    const aliases = JSON.stringify(["Alpha LE", "Alpha"]);
    const mapSource = safeGameSource("/app/maps", "Maps", new URLSearchParams({ map: "Alpha LE", map_exact: aliases }).toString())!;
    const restoredMap = gameSourceFromQuery(Object.fromEntries(new URL(gameAnalysisHref("map-game", null, mapSource), "https://example.test").searchParams));
    expect(new URL(ownerNeighborPath("map-game", "all", restoredMap), "https://example.test").searchParams.get("map_exact")).toBe(aliases);
    const source = safeGameSource("/app/replays?keep=1#archive", "Replays", "race=P&search=Rival")!;
    const roundTrip = gameSourceFromQuery(Object.fromEntries(new URL(gameAnalysisHref("one", null, source), "https://example.test").searchParams));
    expect(roundTrip).toEqual(source);
    expect(ownerNeighborPath("one", "all", roundTrip)).toBe("/v1/games/one/neighbors?scope=all&race=P&q=Rival");
  });

  it("rejects redirects, game chains and oversized URLs, and names originating lists", () => {
    for (const raw of ["https://evil.test/app", "//evil.test/app", "/app\\evil", "/app/../settings", "/app/game/a", "/application", "/app?" + "x".repeat(2048)]) expect(safeGameSource(raw)).toBeNull();
    expect(gameSourceFromQuery({ from: ["/app?tab=macro&race=P", "/bad"] })?.label).toBe("Macro");
    expect(gameSourceFromQuery({ from: "/app/maps?focus=Alcyone" })?.label).toBe("Maps");
    expect(gameSourceFromQuery({ from: "/app/macro#leaks" })?.label).toBe("Macro");
    expect(gameSourceFromQuery({ from: "/app?tab=builds", fromLabel: "PvZ – Archon Drop" })?.label).toBe("PvZ – Archon Drop");
    expect(gameAnalysisHref("one", null, { href: "//evil.test", label: "bad" })).toBe("/app/game/one");
    expect(ownerNeighborPath("one", "all", { href: "/app?since=2026-01-01&token=secret&from=bad", label: "Today" })).toBe("/v1/games/one/neighbors?scope=all&since=2026-01-01");
  });
  it("uses history only when the actual previous entry matches the source", () => {
    const source = safeGameSource("/app/replays?race=P")!;
    const browser = { location: { origin: "https://example.test" }, navigation: { currentEntry: { index: 1 }, entries: () => [{ url: "https://example.test/app/replays?race=P" }, { url: "https://example.test/app/game/one" }] } } as unknown as Window;
    expect(previousEntryMatchesSource(source, browser)).toBe(true);
    expect(previousEntryMatchesSource({ ...source, href: "/app/replays?race=T" }, browser)).toBe(false);
    expect(previousEntryMatchesSource(source, { location: browser.location } as Window)).toBe(false);
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildEditorModalProps } from "./editor/BuildEditorModal";
const harness = vi.hoisted(() => ({ apiCall: vi.fn(), getToken: vi.fn(async () => "token"), userId: "owner-a", signedIn: true }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: harness.getToken, userId: harness.userId, isLoaded: true, isSignedIn: harness.signedIn }) }));
vi.mock("@/lib/clientApi", async importOriginal => ({ ...await importOriginal<object>(), apiCall: (...args: unknown[]) => harness.apiCall(...args) }));
vi.mock("./editor", () => ({ BuildEditorModal: (props: BuildEditorModalProps) => <section aria-label="Rich editor"><span>{JSON.stringify({ events: props.events, race: props.race, vsRace: props.vsRace, gameId: props.gameId, name: props.defaultName, createOnly: props.createOnly })}</span></section> }));
import { BuildStartFlow } from "./BuildStartFlow";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
const game = (id = "game-a") => ({ gameId: id, map: id, date: "2026-10-25T10:00:00Z", result: "win", opponent: { displayName: "Opponent" } });
const page = (id = "game-a", nextCursor: string | null = null) => ({ items: [game(id)], page: { hasMore: !!nextCursor, nextCursor } });
const detail = { events: [{ time: 30, name: "BuildGateway", is_building: true }], my_race: "Protoss", opp_race: "Terran" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(cleanup);
beforeEach(() => { harness.apiCall.mockReset(); harness.userId = "owner-a"; harness.signedIn = true; });
describe("one build creation flow", () => {
  it("offers four starting cards, keeps paste unavailable, and opens blank in the rich create-only editor without a read", () => {
    render(<BuildStartFlow onClose={vi.fn()} onSaved={vi.fn()} />);
    expect((screen.getByRole("button", { name: /From a pasted/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Blank build/ }));
    expect(JSON.parse(screen.getByRole("region", { name: "Rich editor" }).textContent!)).toMatchObject({ events: [], createOnly: true });
    expect(harness.apiCall).not.toHaveBeenCalled();
  });
  it("lists only one bounded matchup page and fetches only the selected game's build order", async () => {
    harness.apiCall.mockImplementation((_, path: string) => Promise.resolve(path.includes("build-order") ? detail : page()));
    render(<BuildStartFlow initialChoice="games" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByRole("button", { name: /game-a/ });
    const listPath = new URL(harness.apiCall.mock.calls[0][1], "https://local.test");
    expect(listPath.pathname).toBe("/v1/replays"); expect(Object.fromEntries(listPath.searchParams)).toEqual({ limit: "20", sort: "date_desc", race: "P" });
    expect(harness.apiCall).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /game-a/ }));
    await screen.findByRole("region", { name: "Rich editor" });
    expect(harness.apiCall.mock.calls.map(call => call[1]).filter(path => path.includes("build-order"))).toEqual(["/v1/games/game-a/build-order"]);
    expect(JSON.parse(screen.getByRole("region", { name: "Rich editor" }).textContent!)).toMatchObject({ race: "Protoss", vsRace: "Terran", gameId: "game-a", createOnly: true, events: detail.events });
  });
  it("prefills an exact catalog label and matchup for Make my own variant", async () => {
    const definition = BUILD_DEFINITIONS.find(item => item.matchup === "ZvP")!;
    harness.apiCall.mockResolvedValue(page());
    render(<BuildStartFlow initialChoice="detected" definitionId={definition.id} onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByRole("button", { name: /game-a/ });
    const query = new URL(harness.apiCall.mock.calls[0][1], "https://local.test").searchParams;
    expect(query.get("build")).toBe(definition.name); expect(query.get("race")).toBe("Z"); expect(query.get("opp_race")).toBe("P");
    expect((screen.getByRole("combobox", { name: "Detected build" }) as HTMLInputElement).value).toBe(definition.name);
    expect((screen.getByRole("combobox", { name: "Your race" }) as HTMLSelectElement).disabled).toBe(true);
  });
  it("ignores a held selected build-order read after matchup A→B→A and aborts it", async () => {
    const held = deferred<typeof detail>(); harness.apiCall.mockImplementation((_, path: string) => path.includes("build-order") ? held.promise : Promise.resolve(page()));
    render(<BuildStartFlow initialChoice="games" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /game-a/ }));
    const request = harness.apiCall.mock.calls.find(call => call[1].includes("build-order"))!;
    fireEvent.change(screen.getByRole("combobox", { name: "Your race" }), { target: { value: "Zerg" } });
    expect(request[2].signal.aborted).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Your race" }), { target: { value: "Protoss" } });
    await act(async () => held.resolve(detail));
    expect(screen.queryByRole("region", { name: "Rich editor" })).toBeNull();
    await screen.findByRole("button", { name: /game-a/ });
  });
  it("drops held owner-A rows across a warm owner A→B→A switch", async () => {
    const held = deferred<ReturnType<typeof page>>(); harness.apiCall.mockReturnValueOnce(held.promise).mockResolvedValue(page("fresh"));
    const props = { initialChoice: "games" as const, onClose: vi.fn(), onSaved: vi.fn() };
    const view = render(<BuildStartFlow {...props} />);
    harness.userId = "owner-b"; view.rerender(<BuildStartFlow {...props} />);
    await screen.findByRole("button", { name: /fresh/ });
    harness.userId = "owner-a"; view.rerender(<BuildStartFlow {...props} />);
    await act(async () => held.resolve(page("stale-owner")));
    expect(screen.queryByRole("button", { name: /stale-owner/ })).toBeNull(); await screen.findByRole("button", { name: /fresh/ });
  });
  it("uses cursor paging without fanout and gives a recoverable empty build-order error", async () => {
    harness.apiCall.mockImplementation((_, path: string) => Promise.resolve(path.includes("build-order") ? { ...detail, events: [] } : path.includes("cursor=") ? page("next") : page("first", "cursor-2")));
    render(<BuildStartFlow initialChoice="games" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByRole("button", { name: /first/ }); fireEvent.click(screen.getByRole("button", { name: "Next replays" }));
    await screen.findByRole("button", { name: /next ·/ }); expect(harness.apiCall.mock.calls[1][1]).toContain("cursor=cursor-2");
    fireEvent.click(screen.getByRole("button", { name: /next ·/ })); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no extracted build order"));
    expect(screen.queryByRole("region", { name: "Rich editor" })).toBeNull(); expect((screen.getByRole("button", { name: /next ·/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

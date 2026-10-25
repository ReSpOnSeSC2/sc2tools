import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScoutingBriefCard } from "./ScoutingBriefCard";
import { DockScout } from "@/components/dock/DockScout";
import type { LiveGameEnvelope } from "@/components/overlay/types";
const auth = vi.hoisted(() => ({ userId: "owner", getToken: vi.fn(async () => "fixture") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
const live = (): LiveGameEnvelope => ({ type: "liveGameState", phase: "match_loading", capturedAt: 1, gameKey: "one", opponent: { name: "Opponent", race: "Zerg", profile: { mmr: 4200, league: "Master" } }, streamerHistory: { oppName: "Opponent", oppPulseId: "1-S2-1-42", opponentIdentityMatched: true, opponentNotesWritable: true, opponentNotes: { text: "Private reminder", readAloud: false }, headToHead: { wins: 2, losses: 1 }, openingHistory: [{ name: "Hatch first", samples: 5, of: 7 }], recentGames: [{ gameId: "replay42", result: "Win", lengthText: "8:01", map: "Previous map", myBuild: "Phoenix", oppBuild: "Hatch first" }] } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("live scouting card states", () => {
  it("shows waiting and pending identity without inventing an empty record", () => {
    const view = render(<ScoutingBriefCard live={null} />); expect(screen.getByText("Waiting for your next game")).toBeTruthy();
    view.rerender(<ScoutingBriefCard live={{ ...live(), opponent: {}, streamerHistory: undefined }} />);
    expect(screen.getByText("Pulse lookup pending…")).toBeTruthy(); expect(screen.queryByText(/First meeting/)).toBeNull();
  });
  it("offers a real retry when enrichment is unavailable", () => {
    const retry = vi.fn(); render(<ScoutingBriefCard live={{ ...live(), streamerHistory: undefined }} unavailable onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry scouting" })); expect(retry).toHaveBeenCalledOnce();
  });
  it("retains league/MMR for first meetings and shows counts and all meeting details", () => {
    const value = live(); value.streamerHistory!.headToHead = { wins: 0, losses: 0 };
    value.displayTime = 185;
    render(<ScoutingBriefCard live={value} />);
    expect(screen.getByText("First meeting — no history yet")).toBeTruthy(); expect(screen.getByText("4,200 MMR")).toBeTruthy(); expect(screen.getByText("· Master")).toBeTruthy();
    expect(screen.getByText(/5 of 7 games/)).toBeTruthy(); expect(screen.getByRole("link", { name: "Previous map" }).getAttribute("href")).toBe("/app/game/replay42");
    expect(screen.getByLabelText("Game time").textContent).toBe("3:05");
    expect(screen.getByText("Phoenix vs Hatch first")).toBeTruthy(); expect(screen.getByText("Private reminder")).toBeTruthy();
  });
  it("collapses an in-game brief to a bar and allows expanding it", () => {
    render(<ScoutingBriefCard live={{ ...live(), phase: "match_in_progress" }} />);
    expect(screen.getByText("Private reminder").closest("[hidden]")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: /^Brief$/ }));
    expect(screen.getByText("Private reminder")).toBeTruthy();
  });
  it("never renders private content/actions in the actual Dock consumer", () => {
    render(<DockScout live={live()} />);
    expect(screen.getByText(/Your record: 2W 1L/)).toBeTruthy(); expect(screen.queryByText("Private reminder")).toBeNull();
    expect(document.querySelectorAll("a,textarea,button").length).toBe(0); expect(document.body.textContent).not.toContain("1-S2-1-42");
  });
  it("does not unlock a save for a first-meeting toon without an owned opponent row", () => {
    const value = live(); value.streamerHistory!.opponentNotesWritable = false;
    render(<ScoutingBriefCard live={value} />); expect(screen.queryByRole("button", { name: "Add note" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open dossier" })).toBeNull(); expect(screen.getByText(/after this account’s first replay syncs/)).toBeTruthy();
  });
  it("preserves an open draft as the loading brief becomes an in-game bar", () => {
    const value = live(), view = render(<ScoutingBriefCard live={value} />);
    fireEvent.click(screen.getByRole("button", { name: "Add note" })); fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this draft" } });
    view.rerender(<ScoutingBriefCard live={{ ...value, phase: "match_in_progress" }} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Done" })); fireEvent.click(screen.getByRole("button", { name: /^Brief$/ })); fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep this draft");
  });
  it("keeps a newer note draft when an earlier save settles and reports failure", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Unavailable" } }), { status: 503 })); vi.stubGlobal("fetch", fetch);
    render(<ScoutingBriefCard live={live()} />); fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    const field = screen.getByRole("textbox", { name: "Note for next meeting" }); fireEvent.change(field, { target: { value: "First edit" } }); fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); fireEvent.change(field, { target: { value: "Newer edit" } });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ notes: "First edit", preserveReadAloud: true });
    await act(async () => finish(new Response(JSON.stringify({ notes: "First edit" }), { status: 200 })));
    expect((field as HTMLTextAreaElement).value).toBe("Newer edit"); fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText(/Couldn’t save this note/)).toBeTruthy(); expect((field as HTMLTextAreaElement).value).toBe("Newer edit");
  });
});

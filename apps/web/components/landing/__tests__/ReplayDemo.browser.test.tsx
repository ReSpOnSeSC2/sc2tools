import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayDemo } from "../ReplayDemo";
import type { BuildEditorModalProps } from "@/components/builds/editor/BuildEditorModal";
import type { EngineClient, EngineInfo, ParseOutcome, ParseRequest, PlayersResult } from "@/lib/instant/types";
import { EngineError } from "@/lib/instant/engineErrors";
const h = vi.hoisted(() => ({ factory: vi.fn(), fetch: vi.fn(), boot: vi.fn(), scan: vi.fn(), parse: vi.fn(), dispose: vi.fn() }));
vi.mock("@/lib/instant/flag", () => ({ getInstantImportMode: () => "all" }));
vi.mock("@/lib/instant/engineClient", () => ({ createEngineClient: (...args: unknown[]) => h.factory(...args) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
vi.mock("@/components/builds/editor", () => ({ BuildEditorModal: (props: BuildEditorModalProps) => props.open ? <section aria-label="Parsed editor"><h2>Parsed build editor</h2><output>{JSON.stringify({ game: props.gameId, race: props.race, vs: props.vsRace, events: props.events, demo: props.demoMode })}</output></section> : null }));
const info: EngineInfo = { engineVersion: "fixture", pyodideVersion: "314.0.7", pythonVersion: "3.14", bundleId: "fixture", bootMs: 1 };
const players: Extract<PlayersResult, { ok: true }> = { ok: true, players: [
  { pid: 1, name: "Alpha", toon: "1-S2-1-1", race: "Protoss", result: "Win" }, { pid: 2, name: "Beta", toon: "1-S2-1-2", race: "Zerg", result: "Loss" },
], date: "2020-01-01T00:00:00Z", map: "Local map", durationSec: 600, matchFormat: "1v1", playerCount: 2, isAiGame: false, toonFromPath: null };
function outcome(request: ParseRequest): ParseOutcome {
  const beta = request.player.toon === "1-S2-1-2", gameId = request.file.name;
  return { ok: true, gameId, date: players.date!, fileName: request.file.name, relativePath: request.file.relativePath, matchFormat: "1v1", isResumedFromReplay: false,
    myToonHandle: request.player.toon, ms: 1, json: JSON.stringify({ gameId, date: players.date, result: beta ? "Defeat" : "Victory", map: players.map, durationSec: 600,
      myRace: beta ? "Zerg" : "Protoss", myToonHandle: request.player.toon, opponent: { displayName: beta ? "Alpha" : "Beta", race: beta ? "Protoss" : "Zerg", toonHandle: beta ? "1-S2-1-1" : "1-S2-1-2" },
      buildLog: beta ? ["[0:20] Overlord"] : ["[0:18] Pylon"], oppBuildLog: beta ? ["[0:18] Pylon"] : ["[0:20] Overlord"] }) };
}
const file = (name = "local.SC2Replay") => new File([new Uint8Array([1, 2])], name, { lastModified: 1 });
const card = () => screen.getByRole("heading", { name: "Turn a replay into a custom build" }).closest("section")!;
const drop = (value = file()) => fireEvent.drop(card(), { dataTransfer: { types: ["Files"], files: [value] } });
beforeEach(() => {
  h.factory.mockReset(); h.fetch.mockReset(); h.boot.mockReset().mockResolvedValue(info); h.scan.mockReset().mockResolvedValue([players]); h.parse.mockReset().mockImplementation(async (requests: ParseRequest[]) => requests.map(outcome)); h.dispose.mockReset();
  h.factory.mockReturnValue({ boot: h.boot, listPlayers: h.scan, parseFiles: h.parse, expandZip: vi.fn(), cancel: vi.fn(), dispose: h.dispose } satisfies EngineClient);
  vi.stubGlobal("fetch", h.fetch); vi.stubGlobal("Worker", class {}); vi.stubGlobal("crypto", { subtle: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("landing browser session with real controller", () => {
  it("does not boot on page view, prewarms on intent, then preserves both perspectives without API traffic", async () => {
    render(<ReplayDemo />); expect(h.factory).not.toHaveBeenCalled(); expect(h.boot).not.toHaveBeenCalled();
    fireEvent.pointerEnter(card()); await waitFor(() => expect(h.boot).toHaveBeenCalled());
    expect(h.factory).toHaveBeenCalledWith({ refreshPolicy: false });
    drop(); await screen.findByRole("heading", { name: "Which player are you?" });
    fireEvent.click(screen.getByRole("button", { name: /Alpha · Protoss/ }));
    const editor = await screen.findByRole("region", { name: "Parsed editor" }); expect(editor.textContent).toContain("Pylon"); expect(editor.textContent).toContain('"demo":true');
    fireEvent.click(screen.getByRole("button", { name: /Beta.*Zerg/ })); expect(editor.isConnected).toBe(false);
    expect(screen.getByRole("region", { name: "Parsed editor" }).textContent).toContain("Overlord");
    expect(h.scan).toHaveBeenCalledTimes(1); expect(h.parse).toHaveBeenCalledTimes(1); expect(h.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "How this works" }).getAttribute("href")).toBe("/try#home-replay-demo");
  });
  it("keeps unsupported browsers local and offers Chrome/Edge or desktop recovery", async () => {
    vi.stubGlobal("Worker", undefined); render(<ReplayDemo />); drop();
    await screen.findByText("This browser cannot run the replay analyzer."); expect(screen.getByRole("link", { name: "use the desktop app" }).getAttribute("href")).toBe("/download");
    expect(h.factory).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("uses shared engine error copy and never falls through to the server", async () => {
    h.boot.mockRejectedValue(new EngineError("integrity_failed", "fixture")); render(<ReplayDemo />); drop();
    await screen.findByText("Download check failed"); expect(screen.getByText(/didn't match its checksum/)).toBeTruthy(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("reports AI skips instead of opening an invented dossier or calling the server", async () => {
    h.scan.mockResolvedValue([{ ...players, isAiGame: true }]); render(<ReplayDemo />); drop();
    await screen.findByText("Games vs the AI"); expect(h.parse).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("can retry the same file after a skipped run without reusing that run's completion", async () => {
    h.scan.mockResolvedValueOnce([{ ...players, isAiGame: true }]).mockResolvedValue([players]); render(<ReplayDemo />); drop();
    await screen.findByText("Games vs the AI"); fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Which player are you?" }); fireEvent.click(screen.getByRole("button", { name: /Alpha · Protoss/ }));
    await screen.findByRole("region", { name: "Parsed editor" }); expect(h.scan).toHaveBeenCalledTimes(2); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("cancels a held parse and ignores its late successful payload", async () => {
    let finish!: (rows: ParseOutcome[]) => void; h.parse.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<ReplayDemo />); drop(); await screen.findByRole("heading", { name: "Which player are you?" });
    fireEvent.click(screen.getByRole("button", { name: /Alpha · Protoss/ })); await waitFor(() => expect(h.parse).toHaveBeenCalledOnce());
    const requests = h.parse.mock.calls[0][0] as ParseRequest[];
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    await act(async () => finish(requests.map(outcome))); expect(screen.queryByRole("region", { name: "Parsed editor" })).toBeNull(); expect(h.fetch).not.toHaveBeenCalled();
  });
});

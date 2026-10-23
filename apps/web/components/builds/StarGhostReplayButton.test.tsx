import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StarGhostReplayButton } from "./StarGhostReplayButton";

const mocks = vi.hoisted(() => ({ request: vi.fn(), mutate: vi.fn(), data: { references: {} }, arm: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: mocks.data, mutate: mocks.mutate }), apiCall: (...args: unknown[]) => mocks.request(...args) }));
vi.mock("@/lib/ghostBuild", () => ({ MAX_GHOST_STEPS: 80, armGhostTargetForMatchup: (...args: unknown[]) => mocks.arm(...args), readArmedGhostConfig: () => null }));
vi.mock("@/components/analyzer/game/useArmGhostTarget", () => ({ GHOST_ARMED_EVENT: "ghost:test" }));
afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.data = { references: {} }; });

describe("replay Ghost reference star", () => {
  it("saves the selected replay for this build without opening the row", async () => {
    const target = { v: 1, name: "Blink", steps: [{ t: 50, name: "Gateway", supply: null }] };
    mocks.request.mockResolvedValue({ v: 1, slots: { PvT: target }, references: { key: { gameId: "replay-1", side: "you", buildKey: "blink", matchup: "PvT", target } } });
    const parent = vi.fn();
    render(<div onClick={parent}><StarGhostReplayButton gameId="replay-1" buildKey="blink" /></div>);
    fireEvent.click(screen.getByRole("button", { name: "Use replay as Ghost reference" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    expect(JSON.parse(mocks.request.mock.calls[0][2].body)).toEqual({ gameId: "replay-1", side: "you", buildKey: "blink", clear: false });
    expect(parent).not.toHaveBeenCalled();
    await screen.findByText(/Reference saved for this build/);
    expect(mocks.arm).toHaveBeenCalledWith("P", "T", target);
  });

  it("shows the existing reference and clears only that game", async () => {
    mocks.data = { references: { key: { gameId: "replay-1", side: "you", buildKey: "blink" } } } as typeof mocks.data;
    mocks.request.mockResolvedValue({ v: 1, slots: {}, references: {} });
    render(<StarGhostReplayButton gameId="replay-1" buildKey="blink" />);
    const button = screen.getByRole("button", { name: "Remove Ghost reference" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    await screen.findByText(/Reference removed/);
    expect(JSON.parse(mocks.request.mock.calls[0][2].body).clear).toBe(true);
  });

  it("keeps the star unselected and offers retry after a failed save", async () => {
    mocks.request.mockRejectedValue(new Error("offline"));
    render(<StarGhostReplayButton gameId="replay-1" />);
    fireEvent.click(screen.getByRole("button"));
    await screen.findByText(/Could not save this reference/);
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("restores the previous reference with an expected-current revision fence", async () => {
    const target = { v: 1, name: "Blink", steps: [{ t: 50, name: "Gateway", supply: null }] };
    const entry = { gameId: "replay-1", side: "you", buildKey: "blink", matchup: "PvT", target, revision: "new" };
    mocks.request.mockResolvedValueOnce({ v: 1, slots: { PvT: target }, references: { key: entry }, history: { key: [{ ...entry, gameId: "older", revision: "old" }] } });
    mocks.request.mockResolvedValueOnce({ v: 1, slots: { PvT: target }, references: { key: { ...entry, gameId: "older", revision: "restored" } }, history: {} });
    render(<StarGhostReplayButton gameId="replay-1" buildKey="blink" />);
    fireEvent.click(screen.getByRole("button", { name: "Use replay as Ghost reference" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo reference change" }));
    await screen.findByText(/Previous reference restored/);
    expect(mocks.request.mock.calls[1][1]).toBe("/v1/me/ghost-builds/reference/restore");
    expect(JSON.parse(mocks.request.mock.calls[1][2].body)).toEqual({ referenceKey: "key", revision: "old", expectedCurrentRevision: "new" });
  });
});

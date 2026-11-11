import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalReplayPanel } from "../report/LocalReplayPanel";

const { sanitize, mountPlayer } = vi.hoisted(() => ({
  sanitize: vi.fn(),
  mountPlayer: vi.fn(),
}));

vi.mock("@/lib/mapReplay", () => ({ sanitizeMapPlayback: sanitize }));
vi.mock("@/components/analyzer/game/replay/CompactReplayHost", () => ({
  CompactReplayHost: (props: { local: boolean; playback: unknown }) => {
    mountPlayer(props);
    return <button type="button">Play fixture</button>;
  },
}));

describe("LocalReplayPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    sanitize.mockReset();
    mountPlayer.mockClear();
  });

  it("waits for the explicit watch action and restores trigger focus on Escape", async () => {
    const data = { raw: "local replay" };
    const playback = { mapName: "Fixture map" };
    sanitize.mockReturnValue(playback);
    render(<LocalReplayPanel data={data} patchEra="before" />);
    const trigger = screen.getByRole("button", { name: "Watch this game" });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(sanitize).not.toHaveBeenCalled();
    expect(mountPlayer).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    expect(screen.getByRole("status").textContent).toContain("Loading replay player");
    await act(async () => { await vi.dynamicImportSettled(); });
    const player = screen.getByRole("button", { name: "Play fixture" });
    expect(sanitize).toHaveBeenCalledWith(data);
    expect(mountPlayer).toHaveBeenCalledWith({ local: true, playback, patchEra: "before" });
    player.focus();
    fireEvent.keyDown(player, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Play fixture" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores a pending load when the replay is closed", async () => {
    sanitize.mockReturnValue({ mapName: "Fixture map" });
    render(<LocalReplayPanel data={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Watch this game" }));
    fireEvent.click(screen.getByRole("button", { name: "Close replay" }));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Watch this game" }));
    expect(sanitize).not.toHaveBeenCalled();
    expect(mountPlayer).not.toHaveBeenCalled();
  });

  it("can retry a load failure and reports an unplayable recording", async () => {
    sanitize.mockImplementationOnce(() => { throw new Error("fixture load failed"); }).mockReturnValueOnce(null);
    render(<LocalReplayPanel data={{}} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Watch this game" })); await vi.dynamicImportSettled(); });
    expect(screen.getByRole("alert").textContent).toContain("The replay player could not load.");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); await vi.dynamicImportSettled(); });
    expect(screen.getByRole("status").textContent).toBe("This game has no playable local recording.");
    expect(mountPlayer).not.toHaveBeenCalled();
  });
});

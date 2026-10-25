import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GhostPracticeSettings } from "../GhostPracticeSettings";
import { writeArmedGhostConfig, type GhostBuildConfig } from "@/lib/ghostBuild";

const h = vi.hoisted(() => ({ owner: "a", config: { v: 2, slots: {} } as GhostBuildConfig, migrate: vi.fn(), assign: vi.fn() }));
vi.mock("@/lib/useGhostPractice", () => ({ useGhostPractice: () => ({ owner: h.owner, config: h.config, migrate: h.migrate, assign: h.assign, loading: false, saving: false }) }));
const target = { v: 1 as const, name: "Browser opening", steps: [{ supply: null, t: 30, name: "Gateway" }] };
beforeEach(() => { localStorage.clear(); h.owner = "a"; h.config = { v: 2, slots: {} }; h.migrate.mockReset().mockResolvedValue(true); h.assign.mockReset(); });
afterEach(cleanup);
describe("explicit browser-to-account Ghost migration", () => {
  it("does not auto-save old data; moves once and preserves the local setup", async () => {
    const legacy: GhostBuildConfig = { v: 2, slots: { PvT: target } }; writeArmedGhostConfig(legacy);
    const view = render(<GhostPracticeSettings />);
    expect(await screen.findByText("Move this browser's assignments to your account")).toBeTruthy(); expect(h.migrate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move assignments" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Move assignments" })).toBeNull());
    expect(h.migrate).toHaveBeenCalledWith(legacy);
    view.unmount(); render(<GhostPracticeSettings />); expect(screen.queryByRole("button", { name: "Move assignments" })).toBeNull();
  });
  it("dismissal is specific to the signed-in owner", async () => {
    writeArmedGhostConfig({ v: 2, slots: { PvT: target } }); const view = render(<GhostPracticeSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep on this browser" }));
    h.owner = "b"; view.rerender(<GhostPracticeSettings />);
    expect(await screen.findByRole("button", { name: "Move assignments" })).toBeTruthy(); expect(h.migrate).not.toHaveBeenCalled();
  });
  it("shows synced targets even when this browser has no local library", () => {
    h.config = { v: 2, slots: { PvT: { ...target, name: "Other browser assignment" } } };
    render(<GhostPracticeSettings />); expect(screen.getByText("Other browser assignment")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear PvT build" })); expect(h.assign).toHaveBeenCalledWith("PvT", null);
  });
});

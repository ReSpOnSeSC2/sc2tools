import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameExportMenu } from "../GameExportMenu";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("game data downloads", () => {
  it("disables unavailable measurements without treating missing data as zeros", () => {
    render(<GameExportMenu game={{ gameId: "g1" }} pending />); (screen.getByText("Export").closest("details") as HTMLDetailsElement).open = true;
    expect((screen.getByRole("button", { name: "Stats CSV" }) as HTMLButtonElement).disabled).toBe(true); expect((screen.getByRole("button", { name: "Casualties CSV" }) as HTMLButtonElement).disabled).toBe(true); expect((screen.getByRole("button", { name: "Full JSON" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("downloads a CSV Blob with a safe replay filename and restores focus", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn().mockReturnValue("blob:export") }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    let filename = ""; vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function(this: HTMLAnchorElement) { filename = this.download; });
    render(<GameExportMenu game={{ gameId: "g1", date: "2026-10-23", myRace: "Protoss", opponent: { race: "Zerg" }, map: "../Blackrock LE" }} macroBreakdown={{ ok: true, stats_events: [{ time: 0, food_used: 12 }], casualty_events: [] }} />);
    const summary = screen.getByText("Export"); (summary.closest("details") as HTMLDetailsElement).open = true; fireEvent.click(screen.getByRole("button", { name: "Stats CSV" }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob)));
    expect(filename).toBe("sc2tools-2026-10-23-PvZ-Blackrock-LE.stats.csv"); expect(document.activeElement).toBe(summary);
  });
});

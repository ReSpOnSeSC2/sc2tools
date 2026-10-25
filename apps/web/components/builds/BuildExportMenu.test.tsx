import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildExportMenu } from "./BuildExportMenu";
import { SavedBuildExportMenu } from "./SavedBuildExportMenu";

const meta = { title: "Gate expand", matchup: "PvZ", author: "Reaver", sourceUrl: "/community/builds/gate" };
const steps = [{ time: 17, name: "Pylon", supply: 14 }, { time: 42, name: "Gateway", supply: 16, supplyApprox: true }];
function open() { const summary = screen.getByLabelText("Build actions for Gate expand"); (summary.closest("details") as HTMLDetailsElement).open = true; return summary; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("build actions", () => {
  it("prefers reference plans over rule deadlines and retains unknown clocks without private provenance", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SavedBuildExportMenu meta={meta} build={{ rules: [{ type: "before", name: "BuildStargate", time_lt: 300 }], buildOrder: { v: 1, source: "game", sourceGameId: "private-secret", steps: [{ t: null, supply: 14, action: "Future action", note: "A | B" }] } }} />);
    open(); expect(screen.queryByRole("button", { name: "Copy SALT" })).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain("| — | 14 | Future action | A \\| B |");
    expect(writeText.mock.calls[0][0]).not.toMatch(/private-secret|Stargate|0:00/);
  });
  it.each(["Escape", "outside"])("keeps focus after %s dismisses a pending clipboard permission request", async dismiss => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const writeText = vi.fn(() => pending); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<><BuildExportMenu steps={steps} meta={meta} /><button type="button">Another control</button></>);
    const summary = open(); fireEvent.click(screen.getByRole("button", { name: "Copy build order" })); await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const next = screen.getByRole("button", { name: "Another control" });
    if (dismiss === "Escape") fireEvent.keyDown(summary, { key: "Escape" }); else fireEvent.pointerDown(next);
    next.focus(); await act(async () => { reject(new Error("denied later")); await Promise.resolve(); });
    expect(screen.queryByRole("textbox", { name: "Copy this build order" })).toBeNull(); expect(document.activeElement).toBe(next);
  });
  it("copies actual formatted steps with absolute attribution and returns focus", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<BuildExportMenu steps={steps} meta={meta} />); const summary = open();
    fireEvent.click(screen.getByRole("button", { name: "Copy as supply build" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("≈16 Gateway [0:42]")));
    expect(writeText.mock.calls[0][0]).toContain(`${window.location.origin}/community/builds/gate`);
    expect(summary.closest("details")?.hasAttribute("open")).toBe(false); expect(document.activeElement).toBe(summary);
  });
  it("focuses and selects an accessible fallback when clipboard permission is denied", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<BuildExportMenu steps={steps} meta={meta} />); open(); fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    const input = await screen.findByRole("textbox", { name: "Copy this build order" });
    expect(document.activeElement).toBe(input); expect(input.hasAttribute("readonly")).toBe(true);
    expect((input as HTMLTextAreaElement).selectionEnd).toBe((input as HTMLTextAreaElement).value.length);
    expect((input as HTMLTextAreaElement).value).toContain("| 0:42 | ≈16 | Gateway |");
  });
  it("shows actual unsupported SALT steps inline and permits keyboard dismissal", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<BuildExportMenu steps={[...steps, { time: 80, name: "ShieldBattery", supply: 20 }]} meta={meta} />); const summary = open();
    fireEvent.click(screen.getByRole("button", { name: "Copy SALT" }));
    expect(await screen.findByText("ShieldBattery")).toBeTruthy(); expect(screen.getByText("SALT skipped 1 step:")).toBeTruthy();
    open(); fireEvent.keyDown(summary, { key: "Escape" }); expect(document.activeElement).toBe(summary); expect(summary.closest("details")?.hasAttribute("open")).toBe(false);
  });
  it("prints only the bounded cheat sheet and removes its portal afterward", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      const sheet = document.querySelector("[data-build-print-sheet]"); expect(sheet?.textContent).toContain("First 60 of 65 steps"); expect(sheet?.textContent).not.toContain("Step64");
    });
    render(<BuildExportMenu steps={Array.from({ length: 65 }, (_, time) => ({ time, name: `Step${time}` }))} meta={meta} />); open(); fireEvent.click(screen.getByRole("button", { name: "Print cheat sheet" }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce()); await waitFor(() => expect(document.querySelector("[data-build-print-sheet]")).toBeNull());
  });
  it("exports v3 rule-only builds ahead of stale signatures without invented steps", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SavedBuildExportMenu meta={{ ...meta, author: null }} build={{ rules: [{ type: "before", name: "BuildStargate", time_lt: 300 }], signature: [{ unit: "Marine", beforeSec: 10, count: 4 }] }} />);
    open(); expect((screen.getByRole("button", { name: "Copy SALT" }) as HTMLButtonElement).disabled).toBe(true); fireEvent.click(screen.getByRole("button", { name: "Copy build order" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled()); const text = writeText.mock.calls[0][0]; expect(text).toContain("by Anonymous"); expect(text).toContain("Stargate"); expect(text).not.toContain("Marine"); expect(text).not.toContain("[0:00]");
  });
  it("identifies saved signature deadlines and retains compressed counts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SavedBuildExportMenu meta={meta} build={{ signature: [{ unit: "Marine", beforeSec: 120, count: 4 }] }} />); open(); fireEvent.click(screen.getByRole("button", { name: "Copy build order" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled()); expect(writeText.mock.calls[0][0]).toContain("Signature times are deadlines"); expect(writeText.mock.calls[0][0]).toContain("4× Marine");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BattleReportSection } from "../BattleReportSection";
import { ReportSentence } from "../ReportSentence";
import { reportFixtures } from "@/lib/battleReport/__tests__/fixtures";
import { sanitizeMapPlayback } from "@/lib/mapReplay";
vi.mock("@/components/help/LazyHelpLink", async () => { const { default: Link } = await import("next/link"); return { LazyHelpLink: () => <Link href="/help/battle-reports">How this is written</Link> }; });
vi.mock("../MapStill", () => ({ MapStill: () => <div role="img" aria-label="Rendered map still" /> }));
const copy = vi.fn();
const narrative = (container: HTMLElement) => Array.from(container.querySelectorAll("[data-report-paragraph]")).map((row) => row.textContent).join("\n");
const playback = (shot: number) => sanitizeMapPlayback({ v: 5, mapName: "Alcyone LE", gameLength: 600, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, spawns: [], battles: [], buildings: [], resources: [], units: [{ owner: "me", name: "Marine", born: 0, died: null, wp: [0, 10, 10], attacks: [shot] }], stats: { me: [], opp: [] }, fidelity: { positions: "engine", paths: "observed", creep: "observed", attacks: "observed" } })!;
beforeEach(() => { copy.mockReset(); copy.mockResolvedValue(undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("battle report consumer", () => {
  it("renders deterministic factual prose, three tones, bounded chronological snapshots and shared-clock seeks", () => {
    const seek = vi.fn(), view = render(<BattleReportSection input={reportFixtures[2]} onSeek={seek} />);
    const initial = narrative(view.container);
    expect(screen.getByRole("heading", { name: "Battle report" })).toBeTruthy();
    const frames = screen.getAllByRole("button", { name: /^Seek replay to/ });
    expect(frames.length).toBeGreaterThanOrEqual(2); expect(frames.length).toBeLessThanOrEqual(4);
    frames.forEach((frame) => fireEvent.click(frame));
    const moments = seek.mock.calls.map(([time]) => time as number);
    expect(moments).toEqual([...moments].sort((a, b) => a - b));
    fireEvent.click(screen.getByRole("button", { name: "Tactical" }));
    expect(narrative(view.container)).not.toBe(initial);
    expect(screen.getByRole("button", { name: "Tactical" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Battle report" })); expect(narrative(view.container)).toBe(initial);
    expect(screen.getByRole("link", { name: "How this is written" }).getAttribute("href")).toBe("/help/battle-reports");
    expect(view.container.querySelector("button a, button button")).toBeNull();
  });

  it("copies plain text and Markdown and offers a selected fallback when clipboard access fails", async () => {
    render(<BattleReportSection input={reportFixtures[2]} onSeek={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(copy).toHaveBeenCalledOnce()); expect(copy.mock.calls[0][0]).toContain("No AI."); expect(copy.mock.calls[0][0]).not.toContain("/app/game/");
    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    await waitFor(() => expect(copy).toHaveBeenCalledTimes(2)); expect(copy.mock.calls[1][0]).toContain("/app/game/macro-win?t=");
    copy.mockRejectedValue(new Error("Clipboard unavailable")); fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
    const fallback = await screen.findByRole("textbox", { name: "Copy this battle report" }) as HTMLTextAreaElement;
    expect(fallback.value).toContain("Fixture macro-win"); expect(document.activeElement).toBe(fallback); expect(fallback.selectionStart).toBe(0); expect(fallback.selectionEnd).toBe(fallback.value.length);
    fireEvent.click(screen.getByRole("button", { name: "Caster" })); expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps text independent of segmented window arrivals and uses the chart fallback without any map capture", () => {
    const game = { gameId: "segmented", durationSec: 600, result: "Victory" };
    const view = render(<BattleReportSection input={{ game, playback: playback(90) }} segmented onSeek={vi.fn()} />);
    const before = narrative(view.container); expect(before).not.toContain("weapon cycle"); expect(screen.queryByRole("img", { name: "Rendered map still" })).toBeNull();
    view.rerender(<BattleReportSection input={{ game, playback: playback(300) }} segmented onSeek={vi.fn()} />);
    expect(narrative(view.container)).toBe(before); expect(screen.getAllByText(/Seek the replay to view this moment on the map/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Generate accurate playback/ })).toBeNull();
  });

  it("renders complete playback stills, but prevents copying an account while its recorded details are loading", () => {
    const view = render(<BattleReportSection input={{ game: { gameId: "complete", durationSec: 600 }, playback: playback(90) }} pending onSeek={vi.fn()} />);
    expect(screen.getAllByRole("img", { name: "Rendered map still" })).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Copy text" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<BattleReportSection input={{ game: { gameId: "complete", durationSec: 600 }, playback: playback(90) }} onSeek={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Copy text" }) as HTMLButtonElement).disabled).toBe(false);
    const incomplete = playback(90); incomplete.fidelity = { ...incomplete.fidelity!, complete: false };
    view.rerender(<BattleReportSection input={{ game: { gameId: "complete", durationSec: 600 }, playback: incomplete }} onSeek={vi.fn()} />);
    expect(narrative(view.container)).not.toContain("weapon cycle"); expect(screen.queryByRole("img", { name: "Rendered map still" })).toBeNull();
  });

  it("links both observed fight clocks to their precise fractional times and does not treat a player's name as a clock", () => {
    const seek = vi.fn();
    const view = render(<ReportSentence gameId="a/b" sentence={{ templateId: "fixture", factId: "first-clash", text: "The cluster was at 2:00–2:05.", time: 120.75, timestamps: [120.75, 125.25] }} onSeek={seek} />);
    fireEvent.click(screen.getByRole("link", { name: "Seek replay to 2:00" })); expect(seek).toHaveBeenLastCalledWith(120.75);
    fireEvent.click(screen.getByRole("link", { name: "Seek replay to 2:05" })); expect(seek).toHaveBeenLastCalledWith(125.25);
    expect(screen.getByRole("link", { name: "Seek replay to 2:05" }).getAttribute("href")).toBe("/app/game/a%2Fb?t=125#replay");
    view.rerender(<ReportSentence gameId="names" sentence={{ templateId: "fixture", factId: "setting", text: "0:00 faced 1:23 on the replay's map.", time: 0, timestamps: [0] }} onSeek={seek} />);
    expect(screen.getAllByRole("link")).toHaveLength(1); expect(screen.getByRole("link").textContent).toBe("0:00");
    expect(view.container.textContent).toContain("0:00 faced 1:23");
    view.rerender(<ReportSentence gameId="names" sentence={{ templateId: "fixture", factId: "opponent-correction", text: "Your corrected label was 0:00 pressure.", time: 0, timestamps: [0] }} onSeek={seek} />);
    expect(screen.getAllByRole("link")).toHaveLength(1); expect(view.container.textContent).toContain("label was 0:00 pressure");
  });
});

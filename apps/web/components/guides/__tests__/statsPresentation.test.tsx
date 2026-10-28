import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WinRateCell } from "../WinRateCell";
import { GuideStatsLegend } from "../GuideStatsLegend";
import { GUIDE_CELL_MIN_GAMES, GUIDE_CELL_MIN_USERS, GUIDE_PAGE_MIN_GAMES, GUIDE_STATS_LEGEND } from "@/lib/guides/guideCopy";
import { GUIDE_TREND_FLAT_THRESHOLD } from "@/lib/guides/format";

afterEach(cleanup);
describe("WinRateCell", () => {
  it.each([
    [{ low: 0.6, high: 0.8 }, "▲", "clearly above 50%"],
    [{ low: 0.4, high: 0.6 }, "●", "too close to call"],
    [{ low: 0.2, high: 0.4 }, "▼", "clearly below 50%"],
  ] as const)("adds a visible glyph and spoken verdict for %j", (ci, glyph, phrase) => {
    const { container } = render(<WinRateCell ci={ci} winRate={(ci.low + ci.high) / 2} compact />);
    expect(screen.getByText(glyph).getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText(`, ${phrase}`).className).toBe("sr-only");
    const range = screen.getByText("likely range").parentElement!;
    expect(range.className).toContain("sr-only sm:not-sr-only");
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });
});
describe("GuideStatsLegend", () => {
  it("starts collapsed, explains the shared floors and threshold, and links to Help", () => {
    const { container } = render(<GuideStatsLegend computedAt="2026-10-21T12:00:00Z" />);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getByText(GUIDE_STATS_LEGEND.floors).textContent).toContain(`${GUIDE_CELL_MIN_USERS} players have played ${GUIDE_CELL_MIN_GAMES} games`);
    expect(screen.getByText(GUIDE_STATS_LEGEND.floors).textContent).toContain(`${GUIDE_PAGE_MIN_GAMES} games`);
    expect(screen.getByText(GUIDE_STATS_LEGEND.trend).textContent).toContain(`${GUIDE_TREND_FLAT_THRESHOLD * 100} pp`);
    expect(screen.getByText(/Updated nightly/).textContent).toContain("Oct 21, 2026");
    expect(screen.getByRole("link", { name: GUIDE_STATS_LEGEND.help, hidden: true }).getAttribute("href")).toBe("/help/reading-guide-stats");
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("opens the real likely-range definition from the expanded legend without changing its numbers", async () => {
    const { container } = render(<GuideStatsLegend computedAt={null} />);
    const details = container.querySelector("details")!; details.open = true;
    expect(container.querySelector('[data-glossary-term="likely-range"]')).toBeTruthy();
    const trigger = screen.getByRole("button", { name: "About Likely range" });
    trigger.focus(); fireEvent.click(trigger);
    const tip = await screen.findByRole("dialog", { name: "About Likely range" });
    expect(await within(tip).findByText(/uncertainty around a guide's recorded win rate/)).toBeTruthy();
    expect(within(tip).getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe("/help/glossary#likely-range");
    expect(screen.getByText(GUIDE_STATS_LEGEND.floors).textContent).toContain(`${GUIDE_CELL_MIN_USERS} players`);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
    expect(details.open).toBe(true);
  });
});

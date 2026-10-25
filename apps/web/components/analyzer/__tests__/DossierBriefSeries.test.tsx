import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScoutingBriefCard } from "../ScoutingBriefCard";
import { OpponentSeriesStrip } from "../OpponentSeriesStrip";
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...rest}>{children}</a> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("dossier brief and all-time series consumers", () => {
  it("copies the exact brief and supports selected text when clipboard access fails", async () => {
    const write = vi.fn().mockRejectedValue(new Error("denied")); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    const view = render(<ScoutingBriefCard profile={{ totals: { wins: 2, losses: 1, total: 3, winRate: 2 / 3 } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy brief" })); const field = await screen.findByRole("textbox", { name: "Copy this scouting brief" });
    expect(document.activeElement).toBe(field); expect((field as HTMLTextAreaElement).value).toContain("This view: 2W–1L");
    expect((field as HTMLTextAreaElement).selectionEnd).toBe((field as HTMLTextAreaElement).value.length);
    view.rerender(<ScoutingBriefCard profile={{ name: "Different", totals: { wins: 0, losses: 0, total: 0, winRate: 0 } }} />);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });
  it("uses document firstSeen, newest-right decided links and honest truncated streak bounds", () => {
    const games = [{ id: "last/game", date: "2026-10-20", result: "Win", map: "Alpha" }, { id: "draw", result: "Draw" }, { id: "older", result: "Win" }];
    const view = render(<OpponentSeriesStrip series={{ games, firstSeen: "2020-03-01", lastSeen: "2026-10-20", sourceLimit: 1000, truncated: true }} />);
    expect(screen.getByText("First met Mar 2020")).toBeTruthy(); expect(screen.getByText("Current: W≥2")).toBeTruthy(); expect(screen.getByText("Best in sample: W2")).toBeTruthy(); expect(screen.getByText(/latest 3 meetings/)).toBeTruthy();
    const links = screen.getAllByRole("link"); expect(links.map(link => link.textContent)).toEqual(["W", "W"]); expect(links.at(-1)!.getAttribute("href")).toBe("/app/game/last%2Fgame"); expect(links.at(-1)!.getAttribute("aria-label")).toContain("Win on Alpha");
    view.rerender(<OpponentSeriesStrip series={{ games: [...games, { id: "oldest", result: "Loss" }], sourceLimit: 1000, truncated: true }} />);
    expect(screen.getByText("Current: W2")).toBeTruthy(); expect(screen.queryByText(/W≥/)).toBeNull();
  });
  it("ignores an old copy result after the dossier changes", async () => {
    let finish!: () => void;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => new Promise<void>(resolve => { finish = resolve; }) } });
    const view = render(<ScoutingBriefCard profile={{ totals: { wins: 1, losses: 0, total: 1, winRate: 1 } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy brief" }));
    view.rerender(<ScoutingBriefCard profile={{ totals: { wins: 0, losses: 1, total: 1, winRate: 0 } }} />);
    await act(async () => { finish(); }); expect(screen.queryByText("Brief copied.")).toBeNull(); expect(screen.getByText(/This view: 0W–1L/)).toBeTruthy();
  });
  it("shows only ten decided links while keeping the newest result on the right", () => {
    render(<OpponentSeriesStrip series={{ games: Array.from({ length: 14 }, (_, index) => ({ id: `g${index}`, result: index === 0 ? "Draw" : index === 1 ? "Win" : "Loss" })), sourceLimit: 1000, truncated: false }} />);
    const links = screen.getAllByRole("link"); expect(links).toHaveLength(10); expect(links[0].getAttribute("href")).toBe("/app/game/g10"); expect(links.at(-1)!.getAttribute("href")).toBe("/app/game/g1"); expect(links.at(-1)!.textContent).toBe("W");
  });
});

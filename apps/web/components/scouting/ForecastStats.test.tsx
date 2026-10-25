// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForecastStats } from "./ForecastStats";
import { PredictedStrategiesList } from "../analyzer/PredictedStrategiesList";
import { projectDockScouting } from "@/lib/liveScouting";
import type { LiveGameEnvelope } from "@/components/overlay/types";
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button> }));
afterEach(cleanup);
const forecast = { top: [{ name: "Hatch First", probability: .6, samples: 0, of: 0, why: ["Ladder vs 4000–4499: 60%"] }], effectiveN: 0, confidence: "Low", sampleSize: 0, sourceWindowSize: 0, limit: 50, otherProbability: .4, partial: false, matchup: "PvZ", map: null, prior: { n: 100, pseudoGames: 3, bandLabel: "4000–4499", matchup: "ZvP" } };
describe("shared forecast presentation", () => {
  it("shows a prior-only forecast as Low with zero personal n and count-only reasons", () => {
    render(<ForecastStats value={forecast} />);
    expect(screen.getByText("Low confidence")).toBeTruthy();
    expect(screen.getByText("effective n=0.0")).toBeTruthy();
    expect(screen.getByText("Ladder vs 4000–4499: 60%")).toBeTruthy();
    expect(screen.getByText(/0 eligible observations/)).toBeTruthy();
    expect(screen.queryByText(/0 of last 0/)).toBeNull();
  });
  it("incomplete and malformed new forecasts never resurrect a legacy100% row", () => {
    const view = render(<PredictedStrategiesList forecast={{ ...forecast, partial: true, reason: "source_window_truncated", top: [], otherProbability: 0 }} predictions={[{ strategy: "Old estimate", probability: 1 }]} />);
    expect(screen.getByText(/Forecast unavailable: the latest 1,000/)).toBeTruthy();
    expect(screen.queryByText("Old estimate")).toBeNull();
    view.rerender(<PredictedStrategiesList forecast={null} predictions={[{ strategy: "Old estimate", probability: 1 }]} />);
    expect(screen.getByText("Opening forecast unavailable.")).toBeTruthy(); expect(screen.queryByText("Old estimate")).toBeNull();
  });
  it("calculation explanation is portalled, keyboard scoped, and returns focus after Escape/outside close", async () => {
    render(<div style={{ overflow: "hidden" }}><PredictedStrategiesList forecast={forecast} /></div>);
    const button = screen.getByRole("button", { name: "How is this calculated?" }); button.focus(); fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "How the opening forecast works" });
    expect(dialog.parentElement).toBe(document.body); expect(document.activeElement).toBe(dialog);
    expect(screen.getByText(/After eight eligible games/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(button));
    fireEvent.click(button); fireEvent.click(screen.getByRole("button", { name: "Close forecast explanation" }));
    await waitFor(() => expect(document.activeElement).toBe(button)); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("Dock receives the same bounded public posterior and alias text, with no group ids or notes", () => {
    const live = { type: "liveGameState", phase: "match_started", capturedAt: 1, opponent: { name: "Main", race: "Zerg", toonHandle: "1-S2-1-42" }, streamerHistory: {
      oppName: "Main", oppPulseId: "1-S2-1-42", opponentIdentityMatched: true, openingForecast: forecast,
      alsoPlaysAs: ["Alt"], groupKey: "secret-global-key", opponentNotes: { text: "Private note" },
    } } as unknown as LiveGameEnvelope;
    const result = projectDockScouting(live);
    expect(result?.forecast?.top[0].name).toBe("Hatch First"); expect(result?.alsoPlaysAs).toEqual(["Alt"]);
    expect(JSON.stringify(result)).not.toMatch(/Private note|secret-global-key|1-S2-1-42/);
  });
});

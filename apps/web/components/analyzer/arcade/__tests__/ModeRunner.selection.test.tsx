import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModeRunner } from "../ModeRunner";
import { activeStreakHunter } from "../modes/quizzes/activeStreakHunter";
import { closersEye } from "../modes/quizzes/closersEye";
import type { AnyMode } from "../modes";
import type { ArcadeDataset, GenerateResult } from "../types";

const mocks = vi.hoisted(() => ({ rng: () => 0.5, recordPlay: vi.fn(), earnBadge: vi.fn() }));
vi.mock("../hooks/useArcadeData", () => ({ useArcadeData: vi.fn() }));
vi.mock("../hooks/useDailySeed", () => ({ useDailySeed: () => ({ day: "2026-11-10", tz: "UTC", rng: mocks.rng }) }));
vi.mock("../hooks/useArcadeState", () => ({ useArcadeState: () => ({
  recordPlay: mocks.recordPlay, earnBadge: mocks.earnBadge, state: { buildleByDay: {} },
}) }));
vi.mock("../ShareCard", () => ({ shareCard: vi.fn() }));

const data: ArcadeDataset = { games: [], opponents: [], builds: [], customBuilds: [], communityBuilds: [], matchups: [], maps: [], summary: null, mapPool: [] };
const source = { data, baseData: data, loading: false, error: null, retrySessionPolicy: vi.fn() };
const streakQuestion: Parameters<typeof activeStreakHunter.score>[0] = {
  variant: "your-win", correctIndex: 0,
  candidates: [
    { pulseId: "alice", name: "Alice", longestWin: 6, longestLoss: 1, games: 10 },
    { pulseId: "bob", name: "Bob", longestWin: 1, longestLoss: 6, games: 10 },
    { pulseId: "carol", name: "Carol", longestWin: 4, longestLoss: 4, games: 12 },
    { pulseId: "dave", name: "Dave", longestWin: 2, longestLoss: 2, games: 6 },
  ],
};
const closerQuestion: Parameters<typeof closersEye.score>[0] = {
  correctIndex: 0,
  candidates: [
    { build: "Fast opening", meanWinSec: 300, wins: 8 },
    { build: "Safe opening", meanWinSec: 400, wins: 8 },
    { build: "Third opening", meanWinSec: 500, wins: 8 },
    { build: "Fourth opening", meanWinSec: 600, wins: 8 },
  ],
};

beforeEach(() => { mocks.recordPlay.mockReset(); mocks.earnBadge.mockReset(); });
afterEach(cleanup);

describe("fresh Arcade question selection", () => {
  for (const { realMode, question, answerName } of [
    { realMode: activeStreakHunter, question: streakQuestion, answerName: /^Carol$/ },
    { realMode: closersEye, question: closerQuestion, answerName: /^Third opening/ },
  ]) {
    it(`${realMode.title}: retires the old question while loading and clears the previous pick when options repeat`, async () => {
      const generated = { ok: true as const, minDataMet: true as const, question };
      let finishNext!: (value: GenerateResult<unknown>) => void;
      const generate = vi.fn().mockResolvedValueOnce(generated).mockImplementationOnce(() => new Promise(resolve => { finishNext = resolve; }));
      const mode = { ...realMode, generate } as AnyMode;
      const view = render(<ModeRunner mode={mode} isDaily={false} dataSource={source} />);
      const choice = await screen.findByRole("button", { name: answerName });
      expect(choice.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(choice);
      expect(choice.getAttribute("aria-pressed")).toBe("true");
      expect((choice as HTMLButtonElement).disabled).toBe(true);
      expect(mocks.recordPlay).toHaveBeenCalledOnce();

      // An ordinary rerender keeps the selected answer for this same question.
      view.rerender(<ModeRunner mode={mode} isDaily={false} dataSource={source} />);
      expect(screen.getByRole("button", { name: answerName }).getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Next round →" }));
      await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
      expect(screen.getByText("Building round…")).toBeTruthy();
      expect(screen.queryByRole("button", { name: answerName })).toBeNull();
      expect(screen.queryByRole("button", { name: "Next round →" })).toBeNull();

      // Even the same question object is a new round, with no carried answer.
      await act(async () => finishNext(generated));
      const freshChoice = await screen.findByRole("button", { name: answerName });
      expect(freshChoice).not.toBe(choice);
      expect((freshChoice as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
      expect(freshChoice.classList.contains("bg-accent/10")).toBe(false);
      expect(freshChoice.classList.contains("bg-success/10")).toBe(false);
      fireEvent.click(freshChoice);
      expect(freshChoice.getAttribute("aria-pressed")).toBe("true");
      expect(mocks.recordPlay).toHaveBeenCalledTimes(2);
    });
  }

  it("clears local selection when changed replay data generates a new question in the same round", async () => {
    const generated = { ok: true as const, minDataMet: true as const, question: streakQuestion };
    const generate = vi.fn().mockResolvedValue(generated);
    const mode = { ...activeStreakHunter, generate } as AnyMode;
    const view = render(<ModeRunner mode={mode} isDaily={false} dataSource={source} />);
    const choice = await screen.findByRole("button", { name: "Carol" });
    fireEvent.click(choice);
    const nextData = { ...data, games: [{ gameId: "new", date: "2026-11-10T00:00:00Z", result: "Victory" }] };
    view.rerender(<ModeRunner mode={mode} isDaily={false} dataSource={{ ...source, data: nextData, baseData: nextData }} />);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Carol" }).getAttribute("aria-pressed")).toBe("false"));
    expect(screen.getByRole("button", { name: "Carol" })).not.toBe(choice);
    expect(mocks.recordPlay).toHaveBeenCalledOnce();
  });
});

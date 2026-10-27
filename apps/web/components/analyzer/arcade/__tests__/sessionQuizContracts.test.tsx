import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { firstGameOfDay } from "../modes/quizzes/firstGameOfDay";
import type { ArcadeDataset, ArcadeGame, GenerateInput } from "../types";

afterEach(cleanup);

function validSessions(gamesPerSession: number, result = "Victory"): ArcadeGame[] {
  const start = Date.UTC(2026, 9, 20, 12);
  return Array.from({ length: 5 }, (_, session) => Array.from({ length: gamesPerSession }, (_, index) => ({
    gameId: `valid-${session}-${index}`,
    date: new Date(start + session * 6 * 60 * 60_000 + index * 5 * 60_000).toISOString(),
    result,
  }))).flat();
}

function invalidDates(result: string): ArcadeGame[] {
  return Array.from({ length: 15 }, (_, index) => ({ gameId: `invalid-${index}`, date: "", result }));
}

function inputFor(games: ArcadeGame[]): GenerateInput {
  const data: ArcadeDataset = {
    sessionPolicy: { gapMinutes: 45, source: "preference", storedGapMinutes: 45 },
    games, opponents: [], builds: [], customBuilds: [], communityBuilds: [],
    matchups: [], maps: [], summary: null, mapPool: [],
  };
  return { data, daySeed: "2026-10-27", tz: "UTC", rng: () => 0.5 };
}

async function generatedQuestion(games: ArcadeGame[]) {
  const result = await firstGameOfDay.generate(inputFor(games));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected meaningful session question: ${result.reason}`);
  return result.question;
}

it("renders the real first-game quiz with its generated 45-minute definition", async () => {
  const question = await generatedQuestion(validSessions(4));
  const onAnswer = vi.fn();
  const context: Parameters<typeof firstGameOfDay.render>[0] = {
    question, answer: null, onAnswer, score: null, revealed: false, isDaily: false,
  };
  // Mount the actual exported mode renderer, QuizCard and answer controls.
  // A synthetic ModeRunner renderer would not catch an unbound q in this component.
  render(<>{firstGameOfDay.render(context)}</>);
  expect(screen.getByRole("heading", { name: "First-Game-of-Day" })).toBeTruthy();
  expect(screen.getByText(/A "session" ends after more than 45 minutes without a game/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Higher than overall/ }));
  expect(onAnswer).toHaveBeenCalledOnce(); expect(onAnswer).toHaveBeenCalledWith("higher");
});

it("does not let invalid dates satisfy the existing 20-game sample requirement", async () => {
  const games = [...validSessions(1), ...invalidDates("Defeat")];
  expect(games).toHaveLength(20); // Five valid sessions, only five eligible games.
  const before = structuredClone(games);
  const result = await firstGameOfDay.generate(inputFor(games));
  expect(result).toEqual({ ok: false, reason: "Need ≥20 games before this one is meaningful." });
  expect(games).toEqual(before);
});

it.each([
  { valid: "Victory", invalid: "Defeat", expectedRate: 1 },
  { valid: "Defeat", invalid: "Victory", expectedRate: 0 },
])("invalid-date $invalid rows cannot change the valid $valid comparison", async ({ valid, invalid, expectedRate }) => {
  const accepted = validSessions(4, valid);
  const baseline = await generatedQuestion(accepted);
  const games = [...accepted, ...invalidDates(invalid)];
  const before = structuredClone(games);
  const question = await generatedQuestion(games);
  expect(question).toEqual(baseline);
  expect(question).toMatchObject({ firstGameWr: expectedRate, overallWr: expectedRate,
    sessionsCount: 5, gapMinutes: 45, truth: "within" });
  expect(games).toEqual(before);
});

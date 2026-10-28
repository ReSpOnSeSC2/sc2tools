import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModeRunner, type ModeRunnerDataSource } from "../ModeRunner";
import { opponentBracketPick } from "../modes/quizzes/opponentBracketPick";
import type { AnyMode } from "../modes";
import type { ArcadeDataset } from "../types";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(), recordPlay: vi.fn(), earnBadge: vi.fn(), rng: () => 0.5,
  state: { buildleByDay: {} },
}));
vi.mock("../hooks/useArcadeData", () => ({ useArcadeData: () => { throw new Error("Use the supplied synthetic dataset"); } }));
vi.mock("../hooks/useDailySeed", () => ({ useDailySeed: () => ({ day: "2026-10-27", tz: "UTC", rng: mocks.rng }) }));
vi.mock("../hooks/useArcadeState", () => ({ useArcadeState: () => ({
  recordPlay: mocks.recordPlay, earnBadge: mocks.earnBadge, state: mocks.state,
}) }));
vi.mock("../ShareCard", () => ({ shareCard: vi.fn() }));

const dataset: ArcadeDataset = {
  games: [], opponents: [], builds: [], customBuilds: [], communityBuilds: [],
  matchups: [], maps: [], summary: null, mapPool: [],
};
const dataSource: ModeRunnerDataSource = {
  data: dataset, baseData: dataset, loading: false, error: null,
  retrySessionPolicy: async () => undefined,
};
const candidates = ["Alpha", "Bravo", "Charlie", "Delta"].map((name, index) => ({
  pulseId: `synthetic-${name}`, pulseCharacterId: null, name, displayName: null,
  wins: 1, losses: index + 2, games: index + 3,
  userWinRate: 1 / (index + 3), opponentWinRate: (index + 2) / (index + 3),
}));
const firstQuestion = { variant: "highest-wr-vs-you" as const, candidates, correctIndex: 3 };
const nextQuestion = { variant: "most-faced" as const, candidates, correctIndex: 3 };
// Match the registry's one-time erasure of each mode's question/answer types.
const mode = { ...opponentBracketPick, generate: mocks.generate } as unknown as AnyMode;

beforeEach(() => {
  mocks.generate.mockReset()
    .mockResolvedValueOnce({ ok: true, minDataMet: true, question: firstQuestion })
    .mockResolvedValueOnce({ ok: true, minDataMet: true, question: nextQuestion })
    // Same content, same correct opponent, same slot: content keys cannot reset this safely.
    .mockResolvedValueOnce({ ok: true, minDataMet: true, question: structuredClone(nextQuestion) });
  mocks.recordPlay.mockReset(); mocks.earnBadge.mockReset();
});
afterEach(cleanup);

function choices() {
  return candidates.map(candidate => screen.getByRole("button", { name: candidate.name }));
}

function expectUnanswered() {
  for (const choice of choices()) {
    expect(choice.getAttribute("aria-pressed")).toBe("false");
    expect(choice.hasAttribute("disabled")).toBe(false);
  }
  expect(screen.queryByRole("button", { name: "Next round →" })).toBeNull();
}

it("clears the prior choice between real runner rounds even when the correct opponent and slot repeat", async () => {
  render(<ModeRunner mode={mode} isDaily={false} dataSource={dataSource} />);
  await screen.findByRole("button", { name: "Delta" });
  expectUnanswered();
  fireEvent.click(choices()[3]);
  expect(choices()[3].getAttribute("aria-pressed")).toBe("true");
  expect(choices().every(choice => choice.hasAttribute("disabled"))).toBe(true);
  expect(mocks.recordPlay).toHaveBeenCalledOnce();
  expect(mocks.recordPlay).toHaveBeenLastCalledWith({ modeId: mode.id, tz: "UTC", xp: 10, raw: 1, correct: true });

  fireEvent.click(screen.getByRole("button", { name: "Next round →" }));
  await screen.findByText("played the most", { exact: false });
  await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
  expectUnanswered();
  expect(mocks.recordPlay).toHaveBeenCalledOnce();
  // Keyboard selection must use the current round, including the repeated fourth slot.
  fireEvent.keyDown(window, { key: "4" });
  expect(choices()[3].getAttribute("aria-pressed")).toBe("true");
  expect(mocks.recordPlay).toHaveBeenCalledTimes(2);
  expect(mocks.recordPlay).toHaveBeenLastCalledWith({ modeId: mode.id, tz: "UTC", xp: 10, raw: 1, correct: true });

  fireEvent.click(screen.getByRole("button", { name: "Next round →" }));
  await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(3));
  await waitFor(expectUnanswered);
  expect(mocks.recordPlay).toHaveBeenCalledTimes(2);
  fireEvent.click(choices()[1]);
  expect(choices()[1].getAttribute("aria-pressed")).toBe("true");
  expect(choices()[3].getAttribute("aria-pressed")).toBe("false");
  expect(mocks.recordPlay).toHaveBeenCalledTimes(3);
  expect(mocks.recordPlay).toHaveBeenLastCalledWith({ modeId: mode.id, tz: "UTC", xp: 0, raw: 0, correct: false });
});

it("renders an existing authoritative answer without requiring a local click", () => {
  render(<>{opponentBracketPick.render({
    question: firstQuestion, answer: 3, onAnswer: vi.fn(),
    score: opponentBracketPick.score(firstQuestion, 3), revealed: true, isDaily: true,
  })}</>);
  expect(choices()[3].getAttribute("aria-pressed")).toBe("true");
  expect(choices().slice(0, 3).every(choice => choice.getAttribute("aria-pressed") === "false")).toBe(true);
});

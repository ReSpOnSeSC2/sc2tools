import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModeRunner, type ModeRunnerDataSource } from "../ModeRunner";
import { opponentBracketPick } from "../modes/quizzes/opponentBracketPick";
import type { AnyMode } from "../modes";
import type { ArcadeDataset } from "../types";

/**
 * The Share button on a finished round: what the runner hands to the card
 * (the mode's share wording, never the in-app names) and when it counts a
 * share (only after the card was actually delivered).
 */

// Stable references: the runner regenerates the round whenever the seed's
// rng changes identity, which would wipe the answer before Share appears.
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  shareCard: vi.fn(),
  trackCardShared: vi.fn(),
  recordPlay: vi.fn(),
  earnBadge: vi.fn(),
  rng: () => 0.5,
  state: { buildleByDay: {} },
}));
vi.mock("../hooks/useArcadeData", () => ({ useArcadeData: () => { throw new Error("Use the supplied synthetic dataset"); } }));
vi.mock("../hooks/useDailySeed", () => ({ useDailySeed: () => ({ day: "2026-10-27", tz: "UTC", rng: mocks.rng }) }));
vi.mock("../hooks/useArcadeState", () => ({ useArcadeState: () => ({
  recordPlay: mocks.recordPlay, earnBadge: mocks.earnBadge, state: mocks.state,
}) }));
vi.mock("../ShareCard", () => ({ shareCard: mocks.shareCard }));
vi.mock("@/lib/analytics/shareEvents", () => ({ trackCardShared: mocks.trackCardShared }));

const dataset: ArcadeDataset = {
  games: [], opponents: [], builds: [], customBuilds: [], communityBuilds: [],
  matchups: [], maps: [], summary: null, mapPool: [],
};
const dataSource: ModeRunnerDataSource = {
  data: dataset, baseData: dataset, loading: false, error: null,
  retrySessionPolicy: async () => undefined,
};
const NAMES = ["Alpha", "Bravo", "Charlie", "Delta"];
const candidates = NAMES.map((name, index) => ({
  pulseId: `synthetic-${name}`, pulseCharacterId: null, name, displayName: null,
  wins: 1, losses: index + 2, games: index + 3,
  userWinRate: 1 / (index + 3), opponentWinRate: (index + 2) / (index + 3),
}));
const question = { variant: "highest-wr-vs-you" as const, candidates, correctIndex: 3 };
// Match the registry's one-time erasure of each mode's question/answer types.
const mode = { ...opponentBracketPick, generate: mocks.generate } as unknown as AnyMode;

beforeEach(() => {
  mocks.generate.mockReset().mockResolvedValue({ ok: true, minDataMet: true, question });
  mocks.shareCard.mockReset();
  mocks.trackCardShared.mockReset();
});
afterEach(cleanup);

/** Render a round, pick the wrong opponent and press Share. */
async function answerWrongAndShare() {
  render(<ModeRunner mode={mode} isDaily={false} dataSource={dataSource} />);
  fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
  // The in-app reveal still names the opponents.
  expect(screen.getAllByText(/Delta/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  await waitFor(() => expect(mocks.shareCard).toHaveBeenCalledTimes(1));
}

it("hands the card lettered rivals, never the names the app shows", async () => {
  mocks.shareCard.mockResolvedValue({ shared: true, method: "download" });
  await answerWrongAndShare();

  const card = mocks.shareCard.mock.calls[0][0];
  expect(card.title).toBe(opponentBracketPick.title);
  expect(card.outcome).toBe("wrong");
  expect(card.tag).toBe("Arcade · Quick Play");
  expect(card.lines).toEqual([
    "It was Rival D — 83.3% (5-1).",
    "Rival A · 66.7% (2-1)",
    "Rival B · 75.0% (3-1)",
    "Rival C · 80.0% (4-1)",
    "Rival D · 83.3% (5-1) ★",
  ]);
  const everything = [card.title, card.question, ...card.lines].join("\n");
  for (const name of NAMES) expect(everything).not.toContain(name);
});

it("counts the share once the card has been delivered, by mode and path", async () => {
  mocks.shareCard.mockResolvedValue({ shared: true, method: "clipboard_image" });
  await answerWrongAndShare();

  await waitFor(() => expect(mocks.trackCardShared).toHaveBeenCalledTimes(1));
  expect(mocks.trackCardShared).toHaveBeenCalledWith({
    card: "arcade_round",
    method: "clipboard_image",
    modeId: "opponent-bracket-pick",
  });
});

it.each([
  ["the share sheet was dismissed", { shared: false, method: null }],
  ["the card could not be drawn", undefined],
])("counts nothing when %s", async (_why, delivery) => {
  mocks.shareCard.mockResolvedValue(delivery);
  await answerWrongAndShare();

  // Give the click handler's continuation a turn before asserting silence.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.trackCardShared).not.toHaveBeenCalled();
});

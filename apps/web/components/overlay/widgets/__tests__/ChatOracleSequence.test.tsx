import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatOracleWidget } from "../ChatOracleWidget";
vi.mock("@/lib/clientApi", () => ({ API_BASE: "http://fixture.invalid" }));
const snapshot = { wall: [], oracles: [], prediction: null, clipMoments: [], settlementSequence: 2, latestRoundKey: "two" };
const reveal = (sequence: number, gameKey: string, result: "win" | "loss") => ({ type: "prediction-settled", settlementSequence: sequence, gameKey, result, tally: result === "win" ? { win: 3, loss: 0, total: 3 } : { win: 0, loss: 3, total: 3 }, pointsEach: 10, correctCount: 3, topOracles: [] });
const drain = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => snapshot }))); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("keeps round two's actual reveal when a held round-one frame arrives after all rounds closed", async () => {
  const view = render(<ChatOracleWidget token="owner" />); await drain();
  view.rerender(<ChatOracleWidget token="owner" engagementEvent={reveal(2, "two", "loss")} />); await drain();
  expect(view.container.textContent).toContain("100% LOSS");
  view.rerender(<ChatOracleWidget token="owner" engagementEvent={reveal(1, "one", "win")} />); await drain();
  expect(view.container.textContent).toContain("100% LOSS"); expect(view.container.textContent).not.toContain("100% WIN");
});
it("waits for the durable cursor on a cold source before showing an old frame", async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const view = render(<ChatOracleWidget token="owner" engagementEvent={reveal(1, "one", "win")} />); await drain();
  expect(view.container.textContent).not.toContain("THE ORACLE SPEAKS");
  await act(async () => finish({ ok: true, json: async () => snapshot })); await drain();
  expect(view.container.textContent).not.toContain("100% WIN");
  view.rerender(<ChatOracleWidget token="owner" engagementEvent={reveal(2, "two", "loss")} />); await drain();
  expect(view.container.textContent).toContain("100% LOSS");
});
it("retains the latest round identity through a manual reveal with no oracle accuracy", async () => {
  const view = render(<ChatOracleWidget token="owner" />); await drain();
  view.rerender(<ChatOracleWidget token="owner" engagementEvent={{ type: "prediction-open", gameKey: "manual", locksAtMs: Date.now() + 90_000 }} />); await drain();
  view.rerender(<ChatOracleWidget token="owner" engagementEvent={{ ...reveal(0, "manual", "loss"), manual: true, pointsEach: 0 }} />); await drain();
  expect(view.container.textContent).toContain("resolved manually"); expect(view.container.textContent).toContain("No points or oracle accuracy");
  view.rerender(<ChatOracleWidget token="owner" engagementEvent={reveal(2, "two", "win")} />); await drain();
  expect(view.container.textContent).toContain("resolved manually"); expect(view.container.textContent).not.toContain("100% WIN");
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { useArcadeState } from "../hooks/useArcadeState";
import type { ArcadeState } from "../types";

/**
 * Regression test for the hydrate-vs-mutate race.
 *
 * Symptom: a user with a saved Arcade state (locked Stock Market
 * portfolio, accumulated XP/minerals, unlocked cards) opens the
 * Today tab. Buildle's mount effect runs against the default state
 * BEFORE the GET /v1/me/preferences/arcade response arrives, calls
 * update() to seed `buildleByDay[today]`, and schedules a debounced
 * PUT. The PUT fires with the pre-hydrate snapshot (default + the
 * one seed entry), overwriting the user's real saved progress on the
 * server. Next session: every other field is gone.
 *
 * The fix in useArcadeState defers update() calls until hydrate
 * completes and replays them on top of the remote state.
 */

vi.mock("@/lib/clientApi", () => ({
  apiCall: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    getToken: async () => "tok",
  }),
}));

const apiCallModule = await import("@/lib/clientApi");
const apiCall = vi.mocked(apiCallModule.apiCall);

const SAVED_STATE: Partial<ArcadeState> = {
  xp: { total: 1500, level: 6 },
  minerals: 250,
  stockMarket: {
    weekKey: "2026-W19",
    lockedAt: "2026-05-09T12:00:00Z",
    picks: [
      { slug: "own:Reaper FE", alloc: 60, entryPrice: 75 },
      { slug: "community:dt-stargate", alloc: 40, entryPrice: 83 },
    ],
  },
  leaderboardOptIn: true,
  leaderboardDisplayName: "ResponseSC2",
};

let captured: ReturnType<typeof useArcadeState> | null = null;

function Probe() {
  const hook = useArcadeState();
  useEffect(() => {
    captured = hook;
  });
  return null;
}

describe("useArcadeState hydration race", () => {
  beforeEach(() => {
    captured = null;
    apiCall.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("mutations queued BEFORE hydrate are applied on top of remote state, not in place of it", async () => {
    // Simulate a slow GET so we can fire a mutation before it lands.
    let resolveGet: ((v: Partial<ArcadeState>) => void) | null = null;
    apiCall.mockImplementation(async (_token, path, init) => {
      if (!init || (init as RequestInit).method === undefined) {
        // GET
        return new Promise<Partial<ArcadeState>>((r) => {
          resolveGet = r;
        });
      }
      // PUT — return whatever was sent.
      return JSON.parse(String((init as RequestInit).body || "{}"));
    });

    render(<Probe />);
    // Hook should NOT be hydrated yet.
    await waitFor(() => expect(captured).toBeTruthy());
    expect(captured!.hydrated).toBe(false);

    // Pre-hydrate mutation — mirrors buildle's mount-time seed effect.
    act(() => {
      captured!.update((prev) => ({
        ...prev,
        buildleByDay: {
          ...prev.buildleByDay,
          "2026-05-11": {
            gameId: "g-1",
            questionType: "oppOpener",
            options: ["A", "B"],
            correctIndex: 0,
            pickedIndex: -1,
            correct: false,
          },
        },
      }));
    });

    // Local state has NOT changed yet — the mutator is queued. The
    // critical invariant: state.xp / state.minerals / state.stockMarket
    // still match the default (NOT a partial-default that would be the
    // bug's snapshot).
    expect(captured!.state.xp.total).toBe(0);
    expect(captured!.state.minerals).toBe(0);
    expect(captured!.state.stockMarket).toBeNull();

    // Now resolve the GET — hydrate should drain the queue ON TOP of
    // the remote state.
    await act(async () => {
      resolveGet!(SAVED_STATE);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(captured!.hydrated).toBe(true));

    // After hydrate: remote fields are intact AND the queued mutator
    // ran on top.
    expect(captured!.state.xp.total).toBe(1500);
    expect(captured!.state.minerals).toBe(250);
    expect(captured!.state.stockMarket?.weekKey).toBe("2026-W19");
    expect(captured!.state.stockMarket?.picks).toHaveLength(2);
    expect(captured!.state.leaderboardOptIn).toBe(true);
    expect(captured!.state.buildleByDay["2026-05-11"]).toBeDefined();
    expect(captured!.state.buildleByDay["2026-05-11"].gameId).toBe("g-1");
  });

  test("a pre-hydrate mutation does NOT issue a PUT until hydrate lands; the PUT then carries the merged state", async () => {
    let resolveGet: ((v: Partial<ArcadeState>) => void) | null = null;
    const putCalls: unknown[] = [];
    apiCall.mockImplementation(async (_token, _path, init) => {
      if (!init || (init as RequestInit).method === undefined) {
        return new Promise<Partial<ArcadeState>>((r) => {
          resolveGet = r;
        });
      }
      putCalls.push(JSON.parse(String((init as RequestInit).body || "{}")));
      return JSON.parse(String((init as RequestInit).body || "{}"));
    });

    render(<Probe />);
    await waitFor(() => expect(captured).toBeTruthy());

    // Pre-hydrate mutation.
    act(() => {
      captured!.update((prev) => ({ ...prev, minerals: prev.minerals + 1 }));
    });

    // Wait well past the 600 ms debounce. With the bug, a PUT would
    // fire here carrying the default state + minerals=1 (overwriting
    // the user's saved blob). With the fix, the mutation is queued
    // until hydrate completes and no PUT happens.
    await new Promise((r) => setTimeout(r, 700));
    expect(putCalls).toHaveLength(0);

    // Now hydrate. The queued mutator applies on top of the remote
    // state, then the post-hydrate flush runs against the merged
    // state and exactly one PUT is issued.
    await act(async () => {
      resolveGet!(SAVED_STATE);
      await Promise.resolve();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 700));

    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    const flushed = putCalls[0] as ArcadeState;
    // The hydrated fields survived the round-trip — this is the
    // anti-regression bit. With the bug they'd be wiped to defaults.
    expect(flushed.xp.total).toBe(1500);
    expect(flushed.minerals).toBe(251);
    expect(flushed.stockMarket?.weekKey).toBe("2026-W19");
  }, 10_000);
});

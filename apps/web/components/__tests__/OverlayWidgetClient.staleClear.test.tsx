import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { useClearStalePostGameOnNewMatch } from "../OverlayWidgetClient";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
} from "../overlay/types";

/**
 * Regression test for a real ladder-stream report: the post-game
 * ``LiveGamePayload`` (e.g. "Negod 0W-1L 0%") was sticking on the
 * Opponent + Scouting widgets across into the next match because
 * those widgets prioritise ``live`` over the agent's pre-game
 * envelope and nothing was clearing the cached ``live`` when a new
 * match started.
 *
 * Fix shape: at the ``OverlayWidgetClient`` level, when the bridge
 * reports ``match_loading`` (= the new match's loading screen), drop
 * the cached ``live``. The post-game ``overlay:live`` event will
 * repopulate it after this game's replay parses minutes later.
 *
 * We test the hook directly rather than spinning up the full client
 * (which constructs a real socket.io connection) — the hook is the
 * load-bearing piece of the fix.
 */

function Harness({
  liveGame,
  initialLive,
  out,
}: {
  liveGame: LiveGameEnvelope | null;
  initialLive: LiveGamePayload | null;
  out: { live: LiveGamePayload | null };
}) {
  const [live, setLive] = useState<LiveGamePayload | null>(initialLive);
  useClearStalePostGameOnNewMatch(liveGame, live, setLive);
  out.live = live;
  return null;
}

function envelope(extra: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_loading",
    capturedAt: 0,
    ...extra,
  };
}

describe("useClearStalePostGameOnNewMatch", () => {
  it("clears the cached post-game payload on the FIRST match_loading envelope", () => {
    const out: { live: LiveGamePayload | null } = { live: null };
    const initialLive: LiveGamePayload = {
      oppName: "Negod",
      oppRace: "Terran",
      result: "loss",
      headToHead: { wins: 0, losses: 1 },
    };
    const { rerender } = render(
      <Harness liveGame={null} initialLive={initialLive} out={out} />,
    );
    // Initial state: live is set (post-game payload from previous game).
    expect(out.live).toEqual(initialLive);
    // New match's loading screen lands.
    rerender(
      <Harness
        liveGame={envelope({
          phase: "match_loading",
          gameKey: "new-match",
          opponent: { name: "Invader", race: "Protoss" },
        })}
        initialLive={initialLive}
        out={out}
      />,
    );
    expect(out.live).toBeNull();
  });

  it("does NOT clear on match_ended — the post-game payload is correct or about to arrive", () => {
    const out: { live: LiveGamePayload | null } = { live: null };
    const initialLive: LiveGamePayload = {
      oppName: "Negod",
      oppRace: "Terran",
      result: "loss",
    };
    const { rerender } = render(
      <Harness liveGame={null} initialLive={initialLive} out={out} />,
    );
    rerender(
      <Harness
        liveGame={envelope({
          phase: "match_ended",
          opponent: { name: "Negod", race: "Terran" },
        })}
        initialLive={initialLive}
        out={out}
      />,
    );
    expect(out.live).toEqual(initialLive);
  });

  it("does NOT clear on idle / menu — let the natural visibility timer age out the post-game payload", () => {
    const out: { live: LiveGamePayload | null } = { live: null };
    const initialLive: LiveGamePayload = { oppName: "Negod" };
    const { rerender } = render(
      <Harness liveGame={null} initialLive={initialLive} out={out} />,
    );
    rerender(
      <Harness
        liveGame={envelope({ phase: "idle" })}
        initialLive={initialLive}
        out={out}
      />,
    );
    expect(out.live).toEqual(initialLive);
    rerender(
      <Harness
        liveGame={envelope({ phase: "menu" })}
        initialLive={initialLive}
        out={out}
      />,
    );
    expect(out.live).toEqual(initialLive);
  });

  it("is a no-op when there's no cached post-game payload (idempotent)", () => {
    const out: { live: LiveGamePayload | null } = { live: null };
    const { rerender } = render(
      <Harness
        liveGame={envelope({ phase: "match_loading" })}
        initialLive={null}
        out={out}
      />,
    );
    expect(out.live).toBeNull();
    // Subsequent envelopes (still match_loading or transitioning to
    // match_started) shouldn't loop or thrash.
    rerender(
      <Harness
        liveGame={envelope({ phase: "match_started" })}
        initialLive={null}
        out={out}
      />,
    );
    expect(out.live).toBeNull();
  });

  it("does not re-clear on subsequent match_loading re-emits within the same match", () => {
    // The agent's bridge can re-emit MATCH_LOADING (e.g. agent
    // restart mid-loading-screen). The hook should be idempotent —
    // a second match_loading after live has been cleared once is a
    // no-op.
    const out: { live: LiveGamePayload | null } = { live: null };
    const initialLive: LiveGamePayload = { oppName: "Negod" };
    const setLiveCalls: Array<LiveGamePayload | null> = [];
    function ProbingHarness({ liveGame }: { liveGame: LiveGameEnvelope | null }) {
      const [live, setLive] = useState<LiveGamePayload | null>(initialLive);
      const wrappedSet = (v: LiveGamePayload | null) => {
        setLiveCalls.push(v);
        setLive(v);
      };
      useClearStalePostGameOnNewMatch(liveGame, live, wrappedSet);
      out.live = live;
      return null;
    }
    const { rerender } = render(<ProbingHarness liveGame={null} />);
    rerender(
      <ProbingHarness
        liveGame={envelope({
          phase: "match_loading",
          opponent: { name: "Invader" },
        })}
      />,
    );
    expect(out.live).toBeNull();
    expect(setLiveCalls).toHaveLength(1);
    rerender(
      <ProbingHarness
        liveGame={envelope({
          phase: "match_loading",
          opponent: { name: "Invader" },
          capturedAt: 1,
        })}
      />,
    );
    // No second clear call — the hook should be idempotent on
    // already-null `live`.
    expect(setLiveCalls).toHaveLength(1);
  });
});

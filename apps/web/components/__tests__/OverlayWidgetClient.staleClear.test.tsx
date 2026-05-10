import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useState } from "react";
import { useClearStalePostGameOnGameKeyChange } from "../OverlayWidgetClient";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
} from "../overlay/types";

/**
 * Regression test for the real ladder-stream report: the post-game
 * ``LiveGamePayload`` (e.g. "Negod 0W-1L 0%") was sticking on the
 * Opponent + Scouting widgets across into the next match because
 * those widgets prioritise ``live`` over the agent's pre-game
 * envelope and nothing was clearing the cached ``live`` when a new
 * match started.
 *
 * The original fix was a phase-keyed hook that fired only on
 * ``match_loading``. That worked for the happy path but missed
 * three failure modes: a fast loading screen the agent's poll
 * didn't observe, a server / region switch that went MENU → match
 * without a fresh ``match_loading`` event, and a Browser Source
 * reconnect mid-match where the cached envelope had already
 * advanced past loading.
 *
 * The new hook compares ``liveGame.gameKey`` against
 * ``live.gameKey`` directly — any mismatch means a new match is in
 * play and the stale post-game payload must drop. We test the hook
 * directly (not the full client) because the gameKey comparison is
 * the load-bearing piece.
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
  useClearStalePostGameOnGameKeyChange(liveGame, live, setLive);
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

describe("useClearStalePostGameOnGameKeyChange", () => {
  it("clears the cached post-game payload when the live envelope's gameKey differs from live's", () => {
    const out: { live: LiveGamePayload | null } = { live: null };
    const initialLive: LiveGamePayload = {
      oppName: "Negod",
      oppRace: "Terran",
      result: "loss",
      gameKey: "previous-match",
    };
    const { rerender } = render(
      <Harness liveGame={null} initialLive={initialLive} out={out} />,
    );
    expect(out.live).toEqual(initialLive);
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

  it("fires for ANY phase as long as gameKey changed (not just match_loading)", () => {
    // The whole point of switching from phase-keyed to gameKey-keyed:
    // a fast loading screen can mean the first envelope we see for
    // the new match is ``match_in_progress`` or ``match_started``.
    // The old hook would have missed it; the new one must clear.
    const initialLive: LiveGamePayload = {
      oppName: "Negod",
      gameKey: "previous-match",
    };
    for (const phase of [
      "match_started",
      "match_in_progress",
      "match_ended",
    ] as const) {
      const out: { live: LiveGamePayload | null } = { live: null };
      const { rerender } = render(
        <Harness liveGame={null} initialLive={initialLive} out={out} />,
      );
      expect(out.live).toEqual(initialLive);
      rerender(
        <Harness
          liveGame={envelope({ phase, gameKey: "new-match" })}
          initialLive={initialLive}
          out={out}
        />,
      );
      expect(out.live).toBeNull();
    }
  });

  it("does NOT clear when gameKeys MATCH (a continuing match's tick must not yank live)", () => {
    const initialLive: LiveGamePayload = {
      oppName: "Negod",
      gameKey: "same-match",
      result: "loss",
    };
    const out: { live: LiveGamePayload | null } = { live: null };
    const { rerender } = render(
      <Harness liveGame={null} initialLive={initialLive} out={out} />,
    );
    expect(out.live).toEqual(initialLive);
    rerender(
      <Harness
        liveGame={envelope({
          phase: "match_in_progress",
          gameKey: "same-match",
        })}
        initialLive={initialLive}
        out={out}
      />,
    );
    expect(out.live).toEqual(initialLive);
  });

  it("does NOT clear when ``live`` has no gameKey (no signal — leave it alone)", () => {
    const initialLive: LiveGamePayload = { oppName: "LegacyEntry" };
    const out: { live: LiveGamePayload | null } = { live: null };
    const { rerender } = render(
      <Harness liveGame={null} initialLive={initialLive} out={out} />,
    );
    rerender(
      <Harness
        liveGame={envelope({
          phase: "match_loading",
          gameKey: "new-match",
        })}
        initialLive={initialLive}
        out={out}
      />,
    );
    expect(out.live).toEqual(initialLive);
  });

  it("does NOT clear when ``liveGame`` has no gameKey (legacy envelope)", () => {
    const initialLive: LiveGamePayload = {
      oppName: "Foe",
      gameKey: "current",
    };
    const out: { live: LiveGamePayload | null } = { live: null };
    const { rerender } = render(
      <Harness liveGame={null} initialLive={initialLive} out={out} />,
    );
    rerender(
      <Harness
        liveGame={envelope({ phase: "match_loading" })}
        initialLive={initialLive}
        out={out}
      />,
    );
    expect(out.live).toEqual(initialLive);
  });

  it("is a no-op when there's no cached ``live`` payload", () => {
    const out: { live: LiveGamePayload | null } = { live: null };
    render(
      <Harness
        liveGame={envelope({ phase: "match_loading", gameKey: "k" })}
        initialLive={null}
        out={out}
      />,
    );
    expect(out.live).toBeNull();
  });
});

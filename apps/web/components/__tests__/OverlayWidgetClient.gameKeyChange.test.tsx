import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useState } from "react";
import { useClearStalePostGameOnGameKeyChange } from "../OverlayWidgetClient";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
} from "../overlay/types";

/**
 * Per the spec: ``live`` clears when an ``overlay:liveGame`` with a
 * different gameKey arrives, regardless of phase. This test pins
 * each of the four active-match phases against a stale ``live``
 * payload and asserts the hook drops ``live`` for every one.
 *
 * Why phase-agnostic: the agent's poll loop can land any phase as
 * the FIRST envelope of a new match, depending on how the loading
 * screen timed out and whether the page reconnected mid-game. The
 * gameKey is the authoritative identity signal; phase is just
 * widget-rendering hint material.
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

function env(extra: Partial<LiveGameEnvelope>): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_loading",
    capturedAt: 0,
    ...extra,
  };
}

describe("OverlayWidgetClient — live clears on gameKey change regardless of phase", () => {
  const stale: LiveGamePayload = {
    oppName: "OldOpponent",
    result: "loss",
    gameKey: "old-key",
  };

  it.each([
    ["match_loading"],
    ["match_started"],
    ["match_in_progress"],
    ["match_ended"],
  ])(
    "clears stale ``live`` when an envelope with a NEW gameKey arrives in %s",
    (phase) => {
      const out: { live: LiveGamePayload | null } = { live: null };
      const { rerender } = render(
        <Harness liveGame={null} initialLive={stale} out={out} />,
      );
      expect(out.live).toEqual(stale);
      rerender(
        <Harness
          liveGame={env({
            phase: phase as LiveGameEnvelope["phase"],
            gameKey: "new-key",
          })}
          initialLive={stale}
          out={out}
        />,
      );
      expect(out.live).toBeNull();
    },
  );

  it("does NOT clear ``live`` when the envelope's gameKey matches", () => {
    const live: LiveGamePayload = {
      oppName: "Continuing",
      gameKey: "match-x",
      result: "win",
    };
    const out: { live: LiveGamePayload | null } = { live: null };
    const { rerender } = render(
      <Harness liveGame={null} initialLive={live} out={out} />,
    );
    rerender(
      <Harness
        liveGame={env({
          phase: "match_in_progress",
          gameKey: "match-x",
        })}
        initialLive={live}
        out={out}
      />,
    );
    expect(out.live).toEqual(live);
  });

  it("clears even when only the live envelope's synthetic prelude arrives (server-switch path)", () => {
    // The cloud broker emits a synthetic ``match_loading`` prelude
    // on overlay reconnect / resync when the cached state is past
    // the loading screen. The synthetic flag is telemetry-only —
    // the gameKey-change effect treats it identically to a real
    // event.
    const out: { live: LiveGamePayload | null } = { live: null };
    const stalePrev: LiveGamePayload = {
      oppName: "PreviousMatch",
      gameKey: "previous-key",
    };
    const { rerender } = render(
      <Harness liveGame={null} initialLive={stalePrev} out={out} />,
    );
    rerender(
      <Harness
        liveGame={env({
          phase: "match_loading",
          gameKey: "fresh-key",
          synthetic: true,
        })}
        initialLive={stalePrev}
        out={out}
      />,
    );
    expect(out.live).toBeNull();
  });
});

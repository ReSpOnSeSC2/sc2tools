import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { OpponentWidget } from "../OpponentWidget";
import type { LiveGameEnvelope, LiveGamePayload } from "../../types";

/**
 * OpponentWidget.liveGame — coverage for the pre-game / in-game render
 * path that consumes the desktop agent's ``LiveGameEnvelope``. The
 * post-game ``LiveGamePayload`` rendering is covered by the existing
 * widget snapshots; this file targets the new live-envelope branch.
 */

function envelope(extra: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_loading",
    capturedAt: 0,
    ...extra,
  };
}

describe("OpponentWidget — live envelope path", () => {
  it("renders nothing when the bridge is idle", () => {
    const { container } = render(
      <OpponentWidget
        live={null}
        liveGame={envelope({ phase: "idle" })}
      />,
    );
    expect(container.textContent || "").toBe("");
  });

  it("renders nothing when the bridge is in a menu", () => {
    const { container } = render(
      <OpponentWidget
        live={null}
        liveGame={envelope({ phase: "menu" })}
      />,
    );
    expect(container.textContent || "").toBe("");
  });

  it("renders a skeleton on match_loading without an opponent name", () => {
    // Edge case: the bridge fired MATCH_LOADING the moment the loading
    // screen showed but the /game endpoint hadn't populated players yet.
    // The widget reserves its slot rather than blanking.
    const { container } = render(
      <OpponentWidget
        live={null}
        liveGame={envelope({ phase: "match_loading" })}
      />,
    );
    expect(container.textContent).toContain("Opponent loading…");
    expect(container.textContent).toContain("MMR loading…");
  });

  it("renders opponent name + race once the bridge resolves them", () => {
    const { container } = render(
      <OpponentWidget
        live={null}
        liveGame={envelope({
          phase: "match_loading",
          opponent: { name: "Serral", race: "Zerg" },
        })}
      />,
    );
    expect(container.textContent).toContain("Serral");
    expect(container.textContent).toContain("MMR loading…");
  });

  it("enriches in place when the Pulse profile lands on a follow-up envelope", () => {
    // Simulates the late-Pulse case: MATCH_LOADING with no profile
    // arrives first; ~300 ms later the bridge re-emits the same gameKey
    // with the resolved profile. Re-rendering the widget with the
    // enriched envelope should show MMR without unmounting.
    const partial = envelope({
      phase: "match_loading",
      gameKey: "k",
      opponent: { name: "Serral", race: "Zerg" },
    });
    const enriched = envelope({
      phase: "match_started",
      gameKey: "k",
      opponent: {
        name: "Serral",
        race: "Zerg",
        profile: { mmr: 7100, league: "Grandmaster", confidence: 1 },
      },
    });
    const { rerender, container } = render(
      <OpponentWidget live={null} liveGame={partial} />,
    );
    expect(container.textContent).toContain("MMR loading…");
    rerender(<OpponentWidget live={null} liveGame={enriched} />);
    expect(container.textContent).toContain("Serral");
    expect(container.textContent).toContain("7100 MMR");
    expect(container.textContent).not.toContain("MMR loading…");
  });

  it("falls back to 'MMR unavailable' when Pulse responded but had no MMR", () => {
    // Pulse can return a hit with no team rating row (unranked, banned).
    // Render the panel with the identity but be honest about what's
    // missing rather than implying still-loading.
    const env = envelope({
      phase: "match_started",
      opponent: {
        name: "Cure",
        race: "Terran",
        profile: { confidence: 1 },
      },
    });
    const { container } = render(
      <OpponentWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).toContain("MMR unavailable");
  });

  it("hides when the bridge transitions back to idle even if a stale envelope was rendered", () => {
    const live = envelope({
      phase: "match_started",
      opponent: { name: "Maru", race: "Terran" },
    });
    const { rerender, container } = render(
      <OpponentWidget live={null} liveGame={live} />,
    );
    expect(container.textContent).toContain("Maru");
    rerender(
      <OpponentWidget
        live={null}
        liveGame={envelope({ phase: "idle" })}
      />,
    );
    expect(container.textContent || "").toBe("");
  });

  it("post-game LiveGamePayload wins over the live envelope on the same gameKey", () => {
    // Authoritative path: when the replay parses, the post-game payload
    // arrives carrying the cloud-derived head-to-head + matchup labels.
    // The widget must drop the envelope's reduced-fidelity render the
    // moment it sees the post-game payload.
    const post: LiveGamePayload = {
      oppName: "Serral",
      oppRace: "Zerg",
      oppMmr: 6900,
      myRace: "Protoss",
      matchup: "PvZ",
      headToHead: { wins: 3, losses: 2 },
    };
    const env = envelope({
      phase: "match_ended",
      opponent: {
        name: "Serral",
        race: "Zerg",
        profile: { mmr: 7100 },
      },
    });
    const { container } = render(
      <OpponentWidget live={post} liveGame={env} />,
    );
    expect(container.textContent).toContain("Serral");
    // Post-game MMR (6900) wins; the live envelope's 7100 must not show.
    expect(container.textContent).toContain("6900 MMR");
    expect(container.textContent).toContain("3-2");
    expect(container.textContent).toContain("PvZ");
    expect(container.textContent).not.toContain("7100");
  });

  it("renders nothing when both sources are null", () => {
    const { container } = render(<OpponentWidget live={null} liveGame={null} />);
    expect(container.textContent || "").toBe("");
  });

  it("indicates 'match over' on match_ended without a post-game payload", () => {
    // The bridge fires MATCH_ENDED the instant SC2 reports a result, but
    // the replay parses ~30 s later. Until the post-game payload lands,
    // the widget should keep the panel up labelled appropriately.
    const env = envelope({
      phase: "match_ended",
      opponent: { name: "ByuN", race: "Terran" },
    });
    const { container } = render(
      <OpponentWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).toContain("match over");
    expect(container.textContent).toContain("ByuN");
  });
});

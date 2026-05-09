import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ScoutingWidget } from "../ScoutingWidget";
import type { LiveGameEnvelope, LiveGamePayload } from "../../types";

/**
 * Pre-game scouting card coverage. The post-game card (LAST GAMES list,
 * best-answer, cheese chip) is exercised by the existing widget tests
 * against ``LiveGamePayload``; this file covers the new
 * ``ScoutingPreGameCard`` branch driven by the agent's
 * ``LiveGameEnvelope``.
 */

function envelope(extra: Partial<LiveGameEnvelope> = {}): LiveGameEnvelope {
  return {
    type: "liveGameState",
    phase: "match_loading",
    capturedAt: 0,
    ...extra,
  };
}

describe("ScoutingWidget — live envelope path", () => {
  it("renders nothing when there's no payload at all", () => {
    const { container } = render(
      <ScoutingWidget live={null} liveGame={null} />,
    );
    expect(container.textContent || "").toBe("");
  });

  it("renders nothing when the bridge is idle/menu", () => {
    const { container } = render(
      <ScoutingWidget
        live={null}
        liveGame={envelope({ phase: "menu" })}
      />,
    );
    expect(container.textContent || "").toBe("");
  });

  it("renders 'Looking up opponent…' before Pulse responds", () => {
    const env = envelope({
      phase: "match_loading",
      opponent: { name: "Reynor", race: "Zerg" },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).toContain("Reynor");
    expect(container.textContent).toContain("Looking up opponent…");
  });

  it("renders MMR + league once Pulse responds", () => {
    const env = envelope({
      phase: "match_started",
      opponent: {
        name: "Reynor",
        race: "Zerg",
        profile: {
          mmr: 6850,
          league: "Grandmaster",
          confidence: 1,
        },
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).toContain("6850 MMR");
    expect(container.textContent).toContain("Grandmaster");
  });

  it("falls back to 'Profile lookup unavailable' when Pulse returned without an MMR row", () => {
    // The agent surfaces this case as ``profile`` set with no ``mmr``
    // — the widget must be honest rather than misleadingly stuck on
    // 'Looking up'.
    const env = envelope({
      phase: "match_started",
      opponent: {
        name: "Reynor",
        race: "Zerg",
        profile: { confidence: 0.6, alternatives: ["Reynor#1234"] },
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).toContain("Profile lookup unavailable");
  });

  it("renders an 'Opponent loading…' placeholder when no name is set yet", () => {
    const env = envelope({ phase: "match_loading" });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).toContain("Opponent loading…");
  });

  it("hides itself when the bridge moves back to idle", () => {
    const live = envelope({
      phase: "match_started",
      opponent: { name: "Cure", race: "Terran" },
    });
    const { container, rerender } = render(
      <ScoutingWidget live={null} liveGame={live} />,
    );
    expect(container.textContent).toContain("Cure");
    rerender(
      <ScoutingWidget
        live={null}
        liveGame={envelope({ phase: "idle" })}
      />,
    );
    expect(container.textContent || "").toBe("");
  });

  it("post-game payload wins — pre-game card is replaced by the full LAST GAMES card", () => {
    const post: LiveGamePayload = {
      oppName: "Serral",
      oppRace: "Zerg",
      headToHead: { wins: 1, losses: 0 },
      recentGames: [
        {
          result: "Win",
          lengthText: "12:34",
          map: "Goldenaura LE",
          myBuild: "PvZ - 3 Stargate Phoenix",
          oppBuild: "Zerg - 2-Base Lurker",
        },
      ],
    };
    const env = envelope({
      phase: "match_ended",
      opponent: {
        name: "Serral",
        race: "Zerg",
        profile: { mmr: 7000 },
      },
    });
    const { container } = render(<ScoutingWidget live={post} liveGame={env} />);
    expect(container.textContent).toContain("Serral");
    // Post-game LAST GAMES list is unique to the full card.
    expect(container.textContent).toContain("LAST GAMES");
    expect(container.textContent).toContain("12:34");
    // Live-card text must NOT appear when the post-game wins.
    expect(container.textContent).not.toContain("Looking up opponent…");
    expect(container.textContent).not.toContain("Profile lookup unavailable");
  });

  it("shows alternatives when the bridge's confidence < 1 AND there are real alternatives", () => {
    const env = envelope({
      phase: "match_started",
      opponent: {
        name: "Maru",
        race: "Terran",
        profile: {
          mmr: 6500,
          confidence: 0.6,
          alternatives: ["Maru#1234", "Maru#5678"],
        },
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).toContain("best guess");
    expect(container.textContent).toContain("Maru#1234");
  });

  it("hides the 'best guess' line when alternatives are agent-stub placeholders ('? (?)' etc)", () => {
    // Reproduces a real ladder match where SC2Pulse returned no
    // matches for an unranked opponent; the agent's bridge surfaced a
    // low-confidence stub with `alternatives: ["? (?)", "? (?)"]`.
    // Rendering those literal placeholder strings on the OBS scene
    // looks broken to viewers — filter them out so the card simply
    // omits the disambiguation line.
    const env = envelope({
      phase: "match_started",
      opponent: {
        name: "Negod",
        race: "Terran",
        profile: {
          confidence: 0.1,
          alternatives: ["? (?)", "? (?)"],
        },
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).not.toContain("best guess");
    expect(container.textContent).not.toContain("? (?)");
    // The widget is still rendered with the rest of the card —
    // headline + 'Profile lookup unavailable'.
    expect(container.textContent).toContain("Negod");
    expect(container.textContent).toContain("Profile lookup unavailable");
  });

  it("filters bare '?' entries from the alternatives list while keeping real ones", () => {
    const env = envelope({
      phase: "match_started",
      opponent: {
        name: "Maru",
        race: "Terran",
        profile: {
          confidence: 0.6,
          alternatives: ["?", "Maru#1234", " ", "? (?)"],
        },
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).toContain("best guess");
    expect(container.textContent).toContain("Maru#1234");
    expect(container.textContent).not.toContain("? (?)");
    // The bare '?' from the alternatives list must not leak through
    // — with two placeholders adjacent, an unfiltered join would
    // render '?, Maru#1234'.
    const text = container.textContent || "";
    const altMatches = text.match(/also: (.*?)$/m)?.[1] || "";
    expect(altMatches).not.toMatch(/(^|, )\?(,|$)/);
  });

  it("hides 'best guess' entirely when confidence is < 1 but there are no alternatives at all", () => {
    // Confidence-only signal with no real alternatives is just noise.
    const env = envelope({
      phase: "match_started",
      opponent: {
        name: "Negod",
        race: "Terran",
        profile: {
          confidence: 0.1,
          alternatives: [],
        },
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).not.toContain("best guess");
  });
});

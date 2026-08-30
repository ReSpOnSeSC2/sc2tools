import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ScoutingWidget } from "../ScoutingWidget";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
  OpponentPhases,
} from "../../types";

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

type OpponentNotes = {
  text: string;
  readAloud: boolean;
};

type StreamerHistoryWithNotes = NonNullable<
  LiveGameEnvelope["streamerHistory"]
> & {
  opponentNotes: OpponentNotes;
};

function historyWithNotes(
  history: NonNullable<LiveGameEnvelope["streamerHistory"]>,
  opponentNotes: OpponentNotes,
): StreamerHistoryWithNotes {
  return { ...history, opponentNotes };
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

  it("renders the rich pre-game card (LAST GAMES, RIVAL, H2H, best-answer) when streamerHistory is set", () => {
    // Cloud-side enrichment populated streamerHistory with the full
    // post-game-shaped payload. The widget should render the same
    // rich JSX as the post-game branch — that's the whole point of
    // the enrichment layer.
    const env = envelope({
      phase: "match_started",
      opponent: { name: "Future", race: "Terran" },
      streamerHistory: {
        oppName: "Future",
        oppRace: "Terran",
        myRace: "Protoss",
        matchup: "PvT",
        headToHead: { wins: 3, losses: 5 },
        rival: {
          name: "Future",
          headToHead: { wins: 3, losses: 5 },
        },
        recentGames: [
          {
            result: "Win",
            lengthText: "20:39",
            map: "Ghost River LE",
            myBuild: "PvT - Phoenix into Robo",
            oppBuild: "Banshee Rush",
          },
          {
            result: "Loss",
            lengthText: "8:14",
            map: "Lightshade LE",
            myBuild: "PvT - Macro Transition (Unclassified)",
            oppBuild: "1-1-1 Standard",
          },
        ],
        bestAnswer: {
          build: "PvT - Phoenix into Robo",
          winRate: 0.66,
          total: 9,
        },
        cheeseProbability: 0.55,
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    // Header carries the H2H summary the user asked for ("3W-5L 38%").
    expect(container.textContent).toContain("Future");
    expect(container.textContent).toContain("3W-5L");
    expect(container.textContent).toContain("38%");
    // RIVAL/FAMILIAR tag with prior result.
    expect(container.textContent).toMatch(/RIVAL|FAMILIAR/);
    // LAST GAMES list with build labels.
    expect(container.textContent).toContain("LAST GAMES");
    expect(container.textContent).toContain("20:39");
    expect(container.textContent).toContain("Ghost River LE");
    expect(container.textContent).toContain("PvT - Phoenix into Robo");
    expect(container.textContent).toContain("Banshee Rush");
    // Best-answer + cheese rows.
    expect(container.textContent).toContain("YOUR BEST ANSWER");
    expect(container.textContent).toContain("66%");
    expect(container.textContent).toContain("CHEESE");
  });

  it("keeps the opponent notes panel visible when read-aloud is disabled", () => {
    const env = envelope({
      phase: "match_started",
      opponent: { name: "NightMare", race: "Protoss" },
      streamerHistory: historyWithNotes(
        {
          oppName: "NightMare",
          oppRace: "Protoss",
          headToHead: { wins: 2, losses: 3 },
        },
        {
          text: "Checks the natural at 2:10, then hides a proxy tech structure.",
          readAloud: false,
        },
      ),
    });

    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );

    expect(container.textContent).toMatch(/opponent notes/i);
    expect(container.textContent).toContain(
      "Checks the natural at 2:10, then hides a proxy tech structure.",
    );
  });

  it("caps the LAST GAMES list at three rows when notes consume card space", () => {
    const env = envelope({
      phase: "match_started",
      opponent: { name: "DensityTest", race: "Terran" },
      streamerHistory: historyWithNotes(
        {
          oppName: "DensityTest",
          oppRace: "Terran",
          headToHead: { wins: 1, losses: 4 },
          recentGames: [
            { result: "Win", lengthText: "10:01", map: "Map One LE" },
            { result: "Loss", lengthText: "10:02", map: "Map Two LE" },
            { result: "Win", lengthText: "10:03", map: "Map Three LE" },
            { result: "Loss", lengthText: "10:04", map: "Map Four LE" },
            { result: "Win", lengthText: "10:05", map: "Map Five LE" },
          ],
        },
        {
          text: "Expect a compact two-base timing after the first scout.",
          readAloud: true,
        },
      ),
    });

    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );

    expect(container.textContent).toContain("Map One LE");
    expect(container.textContent).toContain("Map Two LE");
    expect(container.textContent).toContain("Map Three LE");
    expect(container.textContent).not.toContain("Map Four LE");
    expect(container.textContent).not.toContain("Map Five LE");
  });

  it("hides entirely on a real post-game payload (live.result set, no isTest)", () => {
    // Streamer ask: scouting is a PRE-GAME widget. Once the just-
    // finished match's post-game payload arrives, the match-result /
    // post-game / mmr-delta widgets handle the wrap-up — scouting
    // gets out of the way.
    const post: LiveGamePayload = {
      oppName: "Future",
      oppRace: "Terran",
      result: "loss",
      durationSec: 720,
      headToHead: { wins: 5, losses: 1 },
      recentGames: [
        {
          result: "Win",
          lengthText: "12:00",
          map: "Tourmaline LE",
          myBuild: "PvT - Disruptor Drop",
        },
      ],
    };
    const env = envelope({
      phase: "match_ended",
      opponent: { name: "Future", race: "Terran" },
    });
    const { container } = render(<ScoutingWidget live={post} liveGame={env} />);
    // Nothing rendered — the result widgets own the post-game scene.
    expect(container.textContent || "").toBe("");
  });

  it("renders test fires (live.isTest) so the streamer can preview the layout", () => {
    // Test fires from Settings → Overlay → Test pass through `live`
    // with isTest=true. Those should still render so the streamer
    // can verify their OBS layout without queueing a real match.
    const test: LiveGamePayload = {
      isTest: true,
      oppName: "Future",
      oppRace: "Terran",
      result: "win",
      headToHead: { wins: 5, losses: 1 },
      recentGames: [
        {
          result: "Win",
          lengthText: "12:00",
          map: "Tourmaline LE",
          myBuild: "PvT - Disruptor Drop",
        },
      ],
    };
    const { container } = render(
      <ScoutingWidget live={test} liveGame={null} />,
    );
    expect(container.textContent).toContain("Future");
    expect(container.textContent).toContain("5W-1L");
    expect(container.textContent).toContain("LAST GAMES");
    expect(container.textContent).toContain("Disruptor Drop");
  });

  it("removes the legacy OpponentPhases medians block — even when opponentPhases is set the markup is gone", () => {
    // The scouting overlay now renders per-game timelines instead of
    // matchup-wide medians. Pin that the legacy ``opponentPhases``
    // payload no longer drives any markup on the card.
    const opponentPhases: OpponentPhases = {
      typicalFinalPhase: "midLate",
      trajectory: {
        sampleSize: { early: 6, earlyMid: 6, mid: 6, midLate: 5, late: 2 },
        crossings: {
          earlyMidAt: 240,
          midAt: 420,
          midLateAt: 660,
          lateAt: 900,
        },
        finalPhaseDistribution: {
          early: 0,
          earlyMid: 0,
          mid: 1,
          midLate: 3,
          late: 2,
        },
        durationP95Sec: 1080,
      },
      typicalLateComp: {
        units: ["Carrier", "Tempest", "Mothership"],
        sampleCount: 4,
        winRate: 0.73,
      },
    };
    const env = envelope({
      phase: "match_started",
      opponent: { name: "Future", race: "Terran" },
      streamerHistory: {
        oppName: "Future",
        oppRace: "Terran",
        myRace: "Protoss",
        matchup: "PvT",
        headToHead: { wins: 3, losses: 5 },
        opponentPhases,
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(
      container.querySelector('[data-testid="opponent-phase-strip"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="phase-trajectory-strip"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Usually reaches");
    expect(container.textContent).not.toContain("Plays into");
  });

  it("renders nothing of the medians block when opponentPhases is missing", () => {
    // Sanity check: even without the legacy payload the rest of the
    // card renders.
    const env = envelope({
      phase: "match_started",
      opponent: { name: "Future", race: "Terran" },
      streamerHistory: {
        oppName: "Future",
        oppRace: "Terran",
        headToHead: { wins: 1, losses: 1 },
        recentGames: [
          {
            result: "Win",
            lengthText: "8:14",
            map: "Lightshade LE",
          },
        ],
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(
      container.querySelector('[data-testid="opponent-phase-strip"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Usually reaches");
    expect(container.textContent).not.toContain("Plays into");
    expect(container.textContent).toContain("Future");
    expect(container.textContent).toContain("LAST GAMES");
  });

  it("falls back to thin pre-game card when streamerHistory hasn't arrived yet", () => {
    // Brief window between the agent's POST and the cloud's
    // enrichment completing — render the placeholder so the panel
    // reserves its slot.
    const env = envelope({
      phase: "match_loading",
      opponent: { name: "Reynor", race: "Zerg" },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).toContain("Reynor");
    expect(container.textContent).toContain("Looking up opponent…");
    // Rich-card markers must NOT appear yet.
    expect(container.textContent).not.toContain("LAST GAMES");
    expect(container.textContent).not.toContain("RIVAL");
  });

  it("labels a revealed barcode with its SC2Pulse pro name on the rich card", () => {
    // Cloud-enriched history carries the reveal; the envelope's opponent
    // name stays the raw bars. The rich scouting card surfaces both.
    const env = envelope({
      phase: "match_started",
      opponent: { name: "llllllllll", race: "Terran" },
      streamerHistory: {
        oppName: "llllllllll",
        oppRace: "Terran",
        oppRevealedName: "THERIDDLER",
        headToHead: { wins: 0, losses: 1 },
      },
    });
    const { container } = render(
      <ScoutingWidget live={null} liveGame={env} />,
    );
    expect(container.textContent).toContain("THERIDDLER");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  battleCardFilename,
  battleCardShareText,
  buildsLine,
  mmrLine,
  renderBattleCardPng,
  standoutStat,
} from "../battleCard";
import { SHARE_LINK_URL } from "@/components/analyzer/arcade/ShareCard";
import type { GameSummary } from "@/components/analyzer/game/types";

const SLIM: GameSummary = {
  gameId: "g1",
  date: "2026-07-01T10:00:00Z",
  result: "Defeat",
  map: "Ephemeron",
  myRace: "Zerg",
  myBuild: "Roach Allin",
  myMmr: 4100,
  durationSec: 700,
  macroScore: 44,
  spq: 71,
  opponent: {
    displayName: "Foe",
    race: "Terran",
    mmr: 4200,
    strategy: "Terran - 2 Rax",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mmrLine", () => {
  it("shows both MMRs and the signed gap when both are known", () => {
    expect(mmrLine(SLIM)).toBe("MMR 4100 vs 4200 (-100)");
  });

  it("uses a + sign when you outrank the opponent", () => {
    expect(mmrLine({ ...SLIM, myMmr: 4300, opponent: { mmr: 4200 } })).toBe(
      "MMR 4300 vs 4200 (+100)",
    );
  });

  it("degrades to a single MMR when only one side is known", () => {
    expect(mmrLine({ ...SLIM, opponent: { mmr: null } })).toBe("MMR 4100");
    expect(mmrLine({ ...SLIM, myMmr: null, opponent: { mmr: 4200 } })).toBe(
      "Opponent MMR 4200",
    );
  });

  it("returns null when neither MMR is known", () => {
    expect(mmrLine({ ...SLIM, myMmr: null, opponent: { mmr: null } })).toBeNull();
  });
});

describe("buildsLine", () => {
  it("renders 'You: <build>  vs  <opp strategy>'", () => {
    expect(buildsLine(SLIM)).toBe("You: Roach Allin  vs  Terran - 2 Rax");
  });

  it("falls back to Unclassified / Unknown on missing labels", () => {
    expect(buildsLine({ ...SLIM, myBuild: null, opponent: {} })).toBe(
      "You: Unclassified  vs  Unknown",
    );
  });
});

describe("standoutStat", () => {
  it("prefers macro score", () => {
    expect(standoutStat(SLIM)).toBe("Macro score 44/100");
  });

  it("falls back to APM, then SQ, then duration", () => {
    expect(standoutStat({ ...SLIM, macroScore: null, apm: 187 })).toBe("187 APM");
    expect(
      standoutStat({ ...SLIM, macroScore: null, apm: null, spq: 71 }),
    ).toBe("Spending quotient 71");
    expect(
      standoutStat({
        ...SLIM,
        macroScore: null,
        apm: null,
        spq: null,
        durationSec: 700,
      }),
    ).toBe("11:40 on the clock");
  });

  it("returns null when no stat is derivable", () => {
    expect(
      standoutStat({
        gameId: "x",
        macroScore: null,
        apm: null,
        spq: null,
        durationSec: null,
      }),
    ).toBeNull();
  });
});

describe("battleCardShareText", () => {
  it("builds a headline, builds line, MMR, stat and ends with the link-back", () => {
    const text = battleCardShareText(SLIM);
    expect(text).toContain("Defeat — ZvT on Ephemeron");
    expect(text).toContain("You: Roach Allin  vs  Terran - 2 Rax");
    expect(text).toContain("MMR 4100 vs 4200 (-100)");
    expect(text).toContain("Macro score 44/100");
    expect(text.endsWith(SHARE_LINK_URL)).toBe(true);
  });

  it("still link-backs and degrades on missing fields", () => {
    const text = battleCardShareText({
      gameId: "x",
      result: "Victory",
      myRace: "Protoss",
      opponent: { race: "Zerg" },
    });
    expect(text).toContain("Victory — PvZ");
    expect(text).toContain("You: Unclassified  vs  Unknown");
    expect(text).not.toContain("MMR");
    expect(text.endsWith(SHARE_LINK_URL)).toBe(true);
  });

  it("returns just the link for a null game", () => {
    expect(battleCardShareText(null)).toBe(SHARE_LINK_URL);
  });
});

describe("battleCardFilename", () => {
  it("slugs matchup + result", () => {
    expect(battleCardFilename(SLIM)).toBe("sc2-zvt-defeat.png");
  });

  it("is null-safe", () => {
    expect(battleCardFilename(null)).toBe("sc2-game.png");
  });
});

describe("renderBattleCardPng", () => {
  it("returns null for a null game", async () => {
    expect(await renderBattleCardPng(null)).toBeNull();
  });

  it("returns null when the canvas has no 2D context", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      null as unknown as CanvasRenderingContext2D,
    );
    expect(await renderBattleCardPng(SLIM)).toBeNull();
  });

  it("produces a PNG Blob when a 2D context + toBlob are available", async () => {
    const ctxStub = {
      fillStyle: "",
      font: "",
      textBaseline: "",
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: (t: string) => ({ width: String(t).length * 8 }),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctxStub as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      cb: BlobCallback,
    ) {
      cb(new Blob(["png-bytes"], { type: "image/png" }));
    });

    const blob = await renderBattleCardPng(SLIM);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe("image/png");
    // The header word was drawn.
    expect(ctxStub.fillText).toHaveBeenCalled();
  });
});

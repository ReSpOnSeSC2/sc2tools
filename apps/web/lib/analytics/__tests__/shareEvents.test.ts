import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { gaEvent } = vi.hoisted(() => ({ gaEvent: vi.fn() }));
// Mock: capture GA4 events instead of touching window.gtag.
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent }));

import { trackCardShared } from "../shareEvents";

function visit(path: string) {
  window.history.pushState({}, "", path);
}

beforeEach(() => visit("/app/arcade"));
afterEach(() => {
  gaEvent.mockReset();
  visit("/");
});

const ARCADE = `${window.location.origin}/app/arcade`;

describe("trackCardShared", () => {
  it("sends the card kind, the delivery path and the page, and nothing else", () => {
    trackCardShared({ card: "season_recap", method: "download" });
    trackCardShared({ card: "battle_card", method: "web_share" });
    expect(gaEvent.mock.calls).toEqual([
      ["card_shared", { content_type: "season_recap", method: "download", page_location: ARCADE }],
      ["card_shared", { content_type: "battle_card", method: "web_share", page_location: ARCADE }],
    ]);
  });

  it("adds the built-in mode id for an Arcade round", () => {
    trackCardShared({ card: "arcade_round", method: "clipboard_image", modeId: "rivalry-ranker" });
    expect(gaEvent.mock.calls).toEqual([
      [
        "card_shared",
        {
          content_type: "arcade_round",
          method: "clipboard_image",
          page_location: ARCADE,
          content_id: "rivalry-ranker",
        },
      ],
    ]);
  });

  it.each(["Some Player#1234", "1-S2-1-267727", "rival name", "", "UPPER", "a".repeat(41)])(
    "drops a mode id that is not shaped like a built-in one (%j)",
    (modeId) => {
      trackCardShared({ card: "arcade_round", method: "clipboard_text", modeId });
      expect(gaEvent.mock.calls).toEqual([
        [
          "card_shared",
          { content_type: "arcade_round", method: "clipboard_text", page_location: ARCADE },
        ],
      ]);
    },
  );

  it("never reports the game id of the page a battle card is shared from", () => {
    // Some game ids are built as date|OpponentName|map|length.
    const gameId = encodeURIComponent("2026-11-01T20:00:00|SecretFoe#1234|Alcyone LE|700");
    visit(`/app/game/${gameId}?opponent=1-S2-1-9988776&opponentName=SecretFoe&utm_source=discord`);

    trackCardShared({ card: "battle_card", method: "web_share" });

    expect(gaEvent).toHaveBeenCalledTimes(1);
    const [, params] = gaEvent.mock.calls[0];
    expect(params.page_location).toBe(
      `${window.location.origin}/app/game/:gameId?utm_source=discord`,
    );
    const sent = JSON.stringify(params);
    expect(sent).not.toContain("SecretFoe");
    expect(sent).not.toContain("9988776");
    expect(sent).not.toContain("Alcyone");
  });

  it("stays silent on pages that are never reported to analytics", () => {
    for (const path of ["/admin/users", "/overlay/secret-token", "/dock/secret-token"]) {
      visit(path);
      trackCardShared({ card: "arcade_round", method: "download", modeId: "buildle" });
    }
    expect(gaEvent).not.toHaveBeenCalled();
  });
});

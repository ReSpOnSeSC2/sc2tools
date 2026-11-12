import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GA_MEASUREMENT_ID, setConsent } from "@/lib/analytics/consent";
import { trackCardShared } from "../shareEvents";

// The real `gaEvent` runs, so these tests see exactly what reaches gtag:
// the share parameters plus the page that `gaEvent` states on every event.
const gtag = vi.fn();

function visit(path: string) {
  window.history.pushState({}, "", path);
}

beforeEach(() => {
  setConsent("granted");
  window.gtag = gtag;
  visit("/app/arcade");
});
afterEach(() => {
  gtag.mockReset();
  delete window.gtag;
  delete window[`ga-disable-${GA_MEASUREMENT_ID}`];
  window.localStorage.clear();
  visit("/");
});

const ARCADE = `${window.location.origin}/app/arcade`;

describe("trackCardShared", () => {
  it("sends the card kind, the delivery path and the page, and nothing else", () => {
    trackCardShared({ card: "season_recap", method: "download" });
    trackCardShared({ card: "battle_card", method: "web_share" });
    expect(gtag.mock.calls).toEqual([
      ["event", "card_shared", { content_type: "season_recap", method: "download", page_location: ARCADE }],
      ["event", "card_shared", { content_type: "battle_card", method: "web_share", page_location: ARCADE }],
    ]);
  });

  it("adds the built-in mode id for an Arcade round", () => {
    trackCardShared({ card: "arcade_round", method: "clipboard_image", modeId: "rivalry-ranker" });
    expect(gtag.mock.calls).toEqual([
      [
        "event",
        "card_shared",
        {
          content_type: "arcade_round",
          method: "clipboard_image",
          content_id: "rivalry-ranker",
          page_location: ARCADE,
        },
      ],
    ]);
  });

  it.each(["Some Player#1234", "1-S2-1-267727", "rival name", "", "UPPER", "a".repeat(41)])(
    "drops a mode id that is not shaped like a built-in one (%j)",
    (modeId) => {
      trackCardShared({ card: "arcade_round", method: "clipboard_text", modeId });
      expect(gtag.mock.calls).toEqual([
        [
          "event",
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

    expect(gtag).toHaveBeenCalledTimes(1);
    const [, , params] = gtag.mock.calls[0];
    expect(params.page_location).toBe(
      `${window.location.origin}/app/game/:gameId?utm_source=discord`,
    );
    const sent = JSON.stringify(gtag.mock.calls);
    expect(sent).not.toContain("SecretFoe");
    expect(sent).not.toContain("9988776");
    expect(sent).not.toContain("Alcyone");
  });

  it("counts fingerprint and session card deliveries without sending the private session locator", () => {
    visit("/app/analyzer?matchup=PvZ");
    trackCardShared({ card: "fingerprint", method: "clipboard_image" });
    visit("/app/sessions/private-session-id?day=2026-11-01&gamesBefore=private-cursor");
    trackCardShared({ card: "session_report", method: "download" });

    expect(gtag.mock.calls).toEqual([
      ["event", "card_shared", { content_type: "fingerprint", method: "clipboard_image", page_location: `${window.location.origin}/app/analyzer` }],
      ["event", "card_shared", { content_type: "session_report", method: "download", page_location: `${window.location.origin}/app/sessions/:sessionId` }],
    ]);
  });

  it("stays silent on pages that are never reported to analytics", () => {
    for (const path of ["/admin/users", "/overlay/secret-token", "/dock/secret-token"]) {
      visit(path);
      trackCardShared({ card: "arcade_round", method: "download", modeId: "buildle" });
    }
    expect(gtag).not.toHaveBeenCalled();
  });

  it("counts a practice grade card without sending the grade or alias", () => {
    visit("/b/creator-opening?grade=S");
    trackCardShared({ card: "practice_grade", method: "download" });
    expect(gtag.mock.calls).toEqual([
      ["event", "card_shared", { content_type: "practice_grade", method: "download", page_location: `${window.location.origin}/b/:alias` }],
    ]);
  });
});

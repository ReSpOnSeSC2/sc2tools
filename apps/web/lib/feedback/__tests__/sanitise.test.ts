import { describe, expect, it } from "vitest";
import { REQUEST_PATH_MAX, sanitisePagePath, sanitiseRequestPath } from "../sanitise";

describe("sanitiseRequestPath", () => {
  // The same cases as the API's request-log tests, so both sides agree.
  it.each([
    [
      "/v1/multichat/overlay-secret/youtube/poll?token=query-secret&channel=abc",
      "/v1/multichat/[redacted]/youtube/poll?token=%5Bredacted%5D&channel=abc",
    ],
    ["/v1/chatbot/a%2Fb%2Bc/mmr", "/v1/chatbot/[redacted]/mmr"],
    [
      "/v1/overlay-tokens/token-to-revoke/widgets?apiKey=nope",
      "/v1/overlay-tokens/[redacted]/widgets?apiKey=%5Bredacted%5D",
    ],
    ["/v1/device-pairings/PAIR-ME-1234", "/v1/device-pairings/[redacted]"],
    ["/v1/build-intents/live/Alice-vs-Bob-123", "/v1/build-intents/live/[redacted]"],
    ["/v1/games/analysis-corpus?limit=2000&cursor=safe-cursor", "/v1/games/analysis-corpus?limit=2000&cursor=safe-cursor"],
    [
      "/v1/integrations/twitch/callback?code=oauth-code&state=csrf&request_id=safe",
      "/v1/integrations/twitch/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&request_id=safe",
    ],
    ["/v1/games?state=complete&code=protoss", "/v1/games?state=complete&code=protoss"],
    ["/v1/search/quick?q=private-name&unknown=private-build#private-map", "/v1/search/quick"],
    ["https://api.sc2tools.com/V1/SEARCH/QUICK/?anything=private-name", "/v1/search/quick"],
    ["/v1/search/quick/other?limit=5", "/v1/search/quick/other?limit=5"],
    // Typed search text: the same rows as the API's __tests__/searchQueryPrivacy.test.js.
    ["/v1/replays?search=Rival&limit=5&sort=date_desc&enrich=none&window=recent",
      "/v1/replays?search=%5Bredacted%5D&limit=5&sort=date_desc&enrich=none&window=recent"],
    ["/v1/replays?search[]=Rival&limit=5", "/v1/replays?search%5B%5D=%5Bredacted%5D&limit=5"],
    ["/v1/community/builds?view=quick&q=Stargate&limit=8", "/v1/community/builds?view=quick&q=%5Bredacted%5D&limit=8"],
    ["/v1/replays/g-1?search=keep", "/v1/replays/g-1?search=keep"],
  ])("redacts credentials but keeps the route: %s", (input, expected) => {
    expect(sanitiseRequestPath(input)).toBe(expected);
  });

  it("drops the API origin and never keeps a token or overlay key", () => {
    const out = sanitiseRequestPath(
      "https://api.sc2tools.com/v1/multichat/ovl_live_key/config?secret=s1&overlayKey=k2&limit=5",
    );
    expect(out).toBe("/v1/multichat/[redacted]/config?secret=%5Bredacted%5D&overlayKey=%5Bredacted%5D&limit=5");
    expect(out).not.toMatch(/ovl_live_key|s1|k2|api\.sc2tools/);
  });

  it("caps very long paths", () => {
    expect(sanitiseRequestPath(`/v1/${"a".repeat(400)}`)).toHaveLength(REQUEST_PATH_MAX);
  });
});

describe("sanitisePagePath", () => {
  it.each([
    ["/app/opponents/1-S2-1-99?tab=games#top", "/app/opponents/1-S2-1-99"],
    ["/settings?tab=overlay&token=abc", "/settings"],
    ["/overlay/secret-token/widget/scout", "/overlay/[redacted]/widget/scout"],
    ["/dock/secret-token?x=1", "/dock/[redacted]"],
    ["https://sc2tools.com/app", ""],
  ])("%s → %s", (input, expected) => {
    expect(sanitisePagePath(input)).toBe(expected);
  });
});

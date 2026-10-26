import { describe, expect, it } from "vitest";
import { DEFAULT_TWITCH_AUTOMATION, twitchPreferences, twitchCurrent, twitchStatus, validTwitchTemplate } from "../twitchAutomation";
import { STUDIO_AUTOMATION_GUIDES, WIDGET_GUIDES } from "../streamStudioLearn";
import engagement from "../help/articles/stream-studio/viewer-engagement";
describe("Twitch automation bounded public contract", () => {
  it("never enables a corrupt preference or trusts raw server queue capability", () => {
    expect(twitchPreferences({ predictionsEnabled: "true", markersEnabled: 1, windowSec: 10000, titleTemplate: "{secret}", accessToken: "private" })).toEqual(DEFAULT_TWITCH_AUTOMATION);
    expect(twitchStatus({ rankedQueueSupported: true }).rankedQueueSupported).toBe(false);
  });
  it.each(["", "<script>test</script>", "{unsupported}", "line\nline", "x".repeat(141)])("rejects unsafe templates: %j", template => expect(validTwitchTemplate(template)).toBe(false));
  it("accepts exactly the documented variables and bounded supported choices", () => {
    expect(validTwitchTemplate("Will {me} beat {opp} ({oppRace} {oppMmr})?")).toBe(true);
    expect(twitchPreferences({ predictionsEnabled: true, markersEnabled: true, windowSec: 300, titleTemplate: "Win vs {opp}?" })).toMatchObject({ predictionsEnabled: true, windowSec: 300 });
  });
  it("drops malformed current receipts and never offers terminal actions", () => {
    expect(twitchCurrent({ gameKey: "x".repeat(121), prediction: "active" })).toBeNull(); expect(twitchCurrent({ gameKey: "fixture", prediction: "guessed" })).toBeNull();
    expect(twitchCurrent({ gameKey: "fixture", prediction: "resolved", canCancel: true, canResolve: true })).toMatchObject({ canCancel: false, canResolve: false });
  });
  it("publishes a real Learn anchor and matching Help section without adding a fake widget", () => {
    const guide = STUDIO_AUTOMATION_GUIDES.find(row => row.id === "twitch-predictions")!;
    expect(guide.capability).toContain("cannot prove ranked queue status"); expect(guide.settingsHref).toBe("/settings?tab=chat#twitch-automation");
    expect(WIDGET_GUIDES.some(row => String(row.id) === "twitch-predictions")).toBe(false);
    expect(engagement.body.some(row => row.type === "heading" && row.anchor === guide.helpAnchor)).toBe(true);
  });
});

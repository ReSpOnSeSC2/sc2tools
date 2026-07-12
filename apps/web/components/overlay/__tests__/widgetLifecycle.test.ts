import { describe, expect, it } from "vitest";
import { payloadTargetsWidget } from "../widgetLifecycle";

describe("payloadTargetsWidget", () => {
  it("lets real-game and Test-all payloads reach every widget", () => {
    expect(payloadTargetsWidget({}, "opponent")).toBe(true);
    expect(payloadTargetsWidget({ isTest: true }, "ghost-build")).toBe(true);
  });

  it("isolates a Ghost Build probe to its dedicated source", () => {
    const probe = { isTest: true, testWidget: "ghost-build" };
    expect(payloadTargetsWidget(probe, "ghost-build")).toBe(true);
    expect(payloadTargetsWidget(probe, "opponent")).toBe(false);
    expect(payloadTargetsWidget(probe, "randomizer")).toBe(false);
  });
});

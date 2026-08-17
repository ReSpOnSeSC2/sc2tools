import { describe, expect, it } from "vitest";
import { resolveWidgetAudioOwner } from "../widgetAudio";

describe("chat and alert audio ownership", () => {
  it("keeps legacy sources audible and honors explicit owners", () => {
    expect(resolveWidgetAudioOwner("")).toBe(true);
    expect(resolveWidgetAudioOwner("?audio=1")).toBe(true);
    expect(resolveWidgetAudioOwner("?theme=violet&audio=yes")).toBe(true);
  });

  it("keeps geometry-specific visual copies silent", () => {
    expect(resolveWidgetAudioOwner("?audio=0")).toBe(false);
    expect(resolveWidgetAudioOwner("?audio=off&theme=violet")).toBe(false);
  });

  it("fails silent for malformed explicit roles", () => {
    expect(resolveWidgetAudioOwner("?audio=banana")).toBe(false);
    expect(resolveWidgetAudioOwner("?audio=")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { resolveBrollAudioOwner } from "../brollAudio";

describe("B-roll audio ownership", () => {
  it("elects the 1920x1080 copy and mutes the 1080x1920 copy", () => {
    expect(resolveBrollAudioOwner("", 1920, 1080)).toBe(true);
    expect(resolveBrollAudioOwner("", 1080, 1920)).toBe(false);
  });

  it("supports explicit ownership overrides on either scene URL", () => {
    expect(resolveBrollAudioOwner("?audio=0", 1920, 1080)).toBe(false);
    expect(resolveBrollAudioOwner("?audio=1", 1080, 1920)).toBe(true);
    expect(resolveBrollAudioOwner("?demo=1&audio=off", 1920, 1080)).toBe(
      false,
    );
    expect(resolveBrollAudioOwner("?audio=yes", 1080, 1920)).toBe(true);
  });

  it("fails silent when an explicit managed role is malformed", () => {
    expect(resolveBrollAudioOwner("?audio=banana", 1920, 1080)).toBe(false);
    expect(resolveBrollAudioOwner("?audio=", 1920, 1080)).toBe(false);
  });
});

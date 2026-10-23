/**
 * /streaming — the old overlay page sends people to Settings → Overlay
 * through `?tab=`. A `#overlay` hash only works through SettingsShell's
 * legacy fallback, so the redirect must not rely on it.
 */
import { describe, expect, it, vi } from "vitest";

const redirect = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { path });
  }),
);

vi.mock("next/navigation", () => ({ redirect }));

import StreamingPage from "../page";

describe("/streaming", () => {
  it("redirects to exactly /settings?tab=overlay, with no hash", () => {
    expect(() => StreamingPage()).toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/settings?tab=overlay");
  });
});

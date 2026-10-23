/**
 * Today's MMR card links to /settings?tab=profile#pulse-id-help. The
 * Pulse ID help is collapsed by default, so the link has to open it or
 * the Settings anchor scroll has nothing to land on. API, auth and the
 * sibling cards are MOCKS.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({
  apiCall: vi.fn(),
  useApi: () => ({
    data: { battleTag: "Player#1234", pulseIds: [] },
    isLoading: false,
    mutate: vi.fn(),
  }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock("../SettingsPlayerChannels", () => ({ SettingsPlayerChannels: () => null }));
vi.mock("../SettingsPublicProfile", () => ({ SettingsPublicProfile: () => null }));

import { SettingsProfile } from "../SettingsProfile";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("SettingsProfile Pulse ID help anchor", () => {
  it("opens the help when the address points at it", () => {
    window.history.replaceState(null, "", "/settings?tab=profile#pulse-id-help");
    render(<SettingsProfile />);
    const help = document.getElementById("pulse-id-help");
    expect(help).toBeTruthy();
    expect(help?.textContent).toContain("Two ways to find your Pulse ID");
    expect(
      screen.getByRole("button", { name: "How do I find my Pulse ID?" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("keeps it collapsed otherwise", () => {
    window.history.replaceState(null, "", "/settings?tab=profile");
    render(<SettingsProfile />);
    expect(document.getElementById("pulse-id-help")).toBeNull();
  });
});

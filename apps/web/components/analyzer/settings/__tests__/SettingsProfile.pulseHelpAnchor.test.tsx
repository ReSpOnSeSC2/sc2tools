/**
 * Today's MMR card links to /settings?tab=profile#pulse-id-help. The
 * Pulse ID help is collapsed by default, so the link has to open it or
 * the Settings anchor scroll has nothing to land on. API, auth and the
 * sibling cards are MOCKS.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "a", isLoaded: true, isSignedIn: true, getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/clientApi")>(),
  apiCall: vi.fn(),
  useApi: () => ({
    data: { battleTag: "Player#1234", pulseIds: ["98-S2-1-30230", "994428"] },
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
    expect(document.querySelectorAll('[id="pulse-ids"]')).toHaveLength(1);
    expect(document.getElementById("pulse-ids")?.contains(help)).toBe(true);
    expect(document.getElementById("profile-details")?.tagName).toBe("SECTION");
    expect(
      screen.getByRole("button", { name: "How do I find my Pulse ID?" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("keeps it collapsed otherwise", () => {
    window.history.replaceState(null, "", "/settings?tab=profile");
    render(<SettingsProfile />);
    expect(document.getElementById("pulse-id-help")).toBeNull();
  });

  it("keeps PTR toon handles as replay identities without SC2Pulse links", () => {
    render(<SettingsProfile />);
    const saved = within(screen.getByRole("list", { name: "Saved Pulse IDs" }));
    expect(saved.getByText("PTR")).toBeTruthy();
    expect(saved.getAllByRole("link").map((link) => link.getAttribute("aria-label")))
      .toEqual(["Open 994428 on sc2pulse.nephest.com"]);

    fireEvent.change(screen.getByPlaceholderText("994428 or 1-S2-1-267727"), {
      target: { value: "98-S2-1-42" },
    });
    expect(screen.getByText(/It has no SC2Pulse ladder rating/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(saved.getByText("98-S2-1-42")).toBeTruthy();
    expect(saved.getAllByText("PTR")).toHaveLength(2);
    expect(saved.getAllByRole("link")).toHaveLength(1);
  });
});

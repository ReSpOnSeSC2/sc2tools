/**
 * /settings — `?tab=` deep links: the Import tab opens only while the
 * Instant Analysis flag is on. Every tab body is a MOCK stub; the flag
 * hook and search params are mocked. Tabs other than Account load as
 * their own chunks (next/dynamic), so their bodies are awaited.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tab: null as string | null,
  gate: { enabled: false, mode: "off", loading: false },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.tab ? { tab: mocks.tab } : {}),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/instant/useInstantImport", () => ({ useInstantImport: () => mocks.gate }));
vi.mock("@/components/analyzer/settings/SettingsFoundation", () => ({ SettingsFoundation: () => <p>foundation body</p> }));
vi.mock("@/components/analyzer/settings/SettingsProfile", () => ({ SettingsProfile: () => <p>profile body</p> }));
vi.mock("@/components/analyzer/settings/SettingsOverlay", () => ({ SettingsOverlay: () => <p>overlay body</p> }));
vi.mock("@/components/analyzer/settings/SettingsRandomizer", () => ({ SettingsRandomizer: () => <p>randomizer body</p> }));
vi.mock("@/components/analyzer/settings/SettingsVoice", () => ({ SettingsVoice: () => <p>voice body</p> }));
vi.mock("@/components/analyzer/settings/SettingsImport", () => ({ SettingsImport: () => <p>import body</p> }));
vi.mock("@/components/analyzer/settings/SettingsBackups", () => ({ SettingsBackups: () => <p>backups body</p> }));
vi.mock("@/components/analyzer/settings/SettingsMisc", () => ({ SettingsMisc: () => <p>misc body</p> }));
vi.mock("@/components/analyzer/settings/SettingsHelp", () => ({ SettingsHelp: () => <p>help body</p> }));
vi.mock("@/components/build-checkin/BuildCheckInSettings", () => ({ BuildCheckInSettings: () => <p>checkin body</p> }));

import SettingsPage from "../page";

beforeEach(() => {
  mocks.tab = null;
  mocks.gate = { enabled: false, mode: "off", loading: false };
});

afterEach(cleanup);

describe("SettingsPage ?tab=", () => {
  it("opens the Import tab when browser import is enabled", async () => {
    mocks.tab = "import";
    mocks.gate = { enabled: true, mode: "all", loading: false };
    render(<SettingsPage />);
    expect(await screen.findByText("import body")).toBeTruthy();
    expect(screen.getAllByRole("tab", { name: "Import" })).toHaveLength(2);
  });

  it("opens desktop Import even while browser import is disabled", async () => {
    mocks.tab = "import";
    render(<SettingsPage />);
    expect(await screen.findByText("import body")).toBeTruthy();
    expect(screen.queryAllByRole("tab", { name: "Import" })).toHaveLength(2);
    expect(screen.queryByText("foundation body")).toBeNull();
  });

  it("deep-links the Build check-in tab", async () => {
    mocks.tab = "checkin";
    render(<SettingsPage />);
    expect(await screen.findByText("checkin body")).toBeTruthy();
    expect(screen.getAllByRole("tab", { name: "Build check-in" })).toHaveLength(2);
  });

  it("follows a ?tab= change while Settings stays mounted", async () => {
    mocks.tab = "checkin";
    const view = render(<SettingsPage />);
    expect(await screen.findByText("checkin body")).toBeTruthy();
    // e.g. "How build check-in works" links to ?tab=help#build-check-in.
    mocks.tab = "help";
    view.rerender(<SettingsPage />);
    expect(await screen.findByText("help body")).toBeTruthy();
    expect(screen.queryByText("checkin body")).toBeNull();
  });

  it("opens a tab through a registered alias", async () => {
    mocks.tab = "streaming";
    render(<SettingsPage />);
    expect(await screen.findByText("overlay body")).toBeTruthy();
  });

  it("links the help article about the tabs", () => {
    render(<SettingsPage />);
    expect(
      screen.getByRole("link", { name: "What each tab is for" }).getAttribute("href"),
    ).toBe("/help/settings-overview");
  });

  it("opens any other known tab and ignores unknown ones", async () => {
    mocks.tab = "voice";
    render(<SettingsPage />);
    expect(await screen.findByText("voice body")).toBeTruthy();
    cleanup();
    mocks.tab = "nope";
    render(<SettingsPage />);
    expect(screen.getByText("foundation body")).toBeTruthy();
  });

  it("ships Account with the page and names the open tab in the browser tab", async () => {
    render(<SettingsPage />);
    // The default tab is eager: no loading state on the first paint.
    expect(screen.getByText("foundation body")).toBeTruthy();
    expect(document.title).toBe("Account · Settings · SC2 Tools");
    cleanup();
    mocks.tab = "voice";
    render(<SettingsPage />);
    expect(await screen.findByText("voice body")).toBeTruthy();
    expect(document.title).toBe("Voice · Settings · SC2 Tools");
  });

  it.each(["account", "foundation"])("opens the existing Account panel from ?tab=%s", (tab) => {
    mocks.tab = tab;
    render(<SettingsPage />);
    expect(screen.getByRole("tabpanel", { name: "Account" }).textContent).toContain("foundation body");
    expect(document.title).toBe("Account · Settings · SC2 Tools");
  });

  it.each(["preferences", "misc"])("opens the lazy Preferences panel from ?tab=%s", async (tab) => {
    mocks.tab = tab;
    render(<SettingsPage />);
    expect(await screen.findByText("misc body")).toBeTruthy();
    expect(screen.getByRole("tabpanel", { name: "Preferences" }).textContent).toContain("misc body");
    expect(document.title).toBe("Preferences · Settings · SC2 Tools");
  });
});

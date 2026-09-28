/**
 * /settings — `?tab=` deep links: the Import tab opens only while the
 * Instant Analysis flag is on. Every tab body is a MOCK stub; the flag
 * hook and search params are mocked.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tab: null as string | null,
  gate: { enabled: false, mode: "off", loading: false },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.tab ? { tab: mocks.tab } : {}),
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

import SettingsPage from "../page";

beforeEach(() => {
  mocks.tab = null;
  mocks.gate = { enabled: false, mode: "off", loading: false };
});

afterEach(cleanup);

describe("SettingsPage ?tab=", () => {
  it("opens the Import tab when browser import is enabled", () => {
    mocks.tab = "import";
    mocks.gate = { enabled: true, mode: "all", loading: false };
    render(<SettingsPage />);
    expect(screen.getByText("import body")).toBeTruthy();
    expect(screen.getAllByRole("tab", { name: "Import" })).toHaveLength(2);
  });

  it("keeps the Import tab hidden and falls back to Foundation when disabled", () => {
    mocks.tab = "import";
    render(<SettingsPage />);
    expect(screen.queryByText("import body")).toBeNull();
    expect(screen.queryAllByRole("tab", { name: "Import" })).toHaveLength(0);
    expect(screen.getByText("foundation body")).toBeTruthy();
  });

  it("opens any other known tab and ignores unknown ones", () => {
    mocks.tab = "voice";
    render(<SettingsPage />);
    expect(screen.getByText("voice body")).toBeTruthy();
    cleanup();
    mocks.tab = "nope";
    render(<SettingsPage />);
    expect(screen.getByText("foundation body")).toBeTruthy();
  });
});

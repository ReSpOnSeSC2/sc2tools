import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui/Toast";
import { loadLazyHelpLink } from "@/components/help/__tests__/loadLazyHelpLink";
import { SettingsContextProvider } from "../SettingsContext";
import { SETTINGS_SECTIONS } from "@/lib/settingsIndex";
import { SettingsFoundation } from "../SettingsFoundation";
import { SettingsBackups } from "../SettingsBackups";
import { SettingsRandomizer } from "../SettingsRandomizer";
import { SettingsPlayerChannels } from "../SettingsPlayerChannels";
import { SettingsVoice } from "../SettingsVoice";

const fixture = vi.hoisted(() => ({ token: vi.fn(async () => "synthetic"), write: vi.fn(), mutate: vi.fn(), data: {} as Record<string, unknown> }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "synthetic-owner", isLoaded: true, isSignedIn: true, getToken: fixture.token }) }));
vi.mock("@/lib/clientApi", async original => ({
  ...await original<typeof import("@/lib/clientApi")>(),
  useApi: (path: string | null) => {
    const data = path?.startsWith("/v1/custom-builds?") ? fixture.data.customBuilds : path ? fixture.data[path] : undefined;
    if (path && data === undefined) throw new Error(`Unadmitted target fixture read: ${path}`);
    return { data, isLoading: false, isValidating: false, error: null, mutate: fixture.mutate };
  },
  apiCall: (...args: unknown[]) => { fixture.write(...args); throw new Error("Target navigation cannot mutate"); },
}));
vi.mock("@/components/onboarding/useReleaseInfo", () => ({ useReleaseInfo: () => ({ data: { ok: true, latest: "0.24.7" }, isLoading: false, mutate: fixture.mutate }) }));

beforeAll(loadLazyHelpLink, 20_000);

beforeEach(() => {
  fixture.write.mockReset(); fixture.mutate.mockReset();
  fixture.data = {
    "/v1/me": { userId: "synthetic-owner", email: "fixture@example.invalid", agentPaired: false, games: { total: 0, latest: null }, onboarding: { goals: ["play"] } },
    "/v1/me/doctor": { warnings: [] },
    "/v1/me/sync-health": { checkedAt: "2026-10-26T12:00:00.000Z", reported: false, rows: [], devices: [], rejections: null },
    "/v1/me/backups": { items: [] },
    "/v1/me/replay-archive-status": { enabled: false, totalGames: 0, archivedGames: 0, missingGames: 0, archiveComplete: true, backfillVersion: 0, resyncRequestedAt: null, requiresResync: false },
    "/v1/games/hidden": { items: [], nextCursor: null },
    "/v1/me/preferences/randomizer": {},
    "/v1/me/preferences/voice": {},
    "/v1/me/player-channels": { identities: [], entries: [] },
    customBuilds: { items: [], total: 0, nextCursor: null },
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(body: ReactNode) {
  return render(<SWRConfig value={{ provider: () => new Map() }}><ToastProvider><SettingsContextProvider>{body}</SettingsContextProvider></ToastProvider></SWRConfig>);
}
function expectTargets(ids: readonly string[]) {
  for (const id of ids) {
    expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    expect(document.getElementById(id)?.tagName).toBe("SECTION");
  }
  expect(fixture.write).not.toHaveBeenCalled();
}

describe("actual Settings section owners", () => {
  it("renders Account's native setup health, the Sync health shell and two summary Sections exactly once", () => {
    mount(<SettingsFoundation />); expectTargets(SETTINGS_SECTIONS.account.map(section => section.id));
    const list = document.querySelector("#account-summary dl");
    expect(list).not.toBeNull();
    const rows = Array.from(list!.children);
    const pairs = [
      ["Email", "fixture@example.invalid"],
      ["Cloud user ID", "synthetic-owner"],
      ["Games synced", "0"],
      ["Latest sync", "—"],
      ["Agent version", "Not paired"],
    ];
    expect(rows).toHaveLength(pairs.length);
    rows.forEach((row, index) => {
      expect(row.tagName).toBe("DIV");
      expect(row.parentElement).toBe(list);
      expect(Array.from(row.children).map(child => child.tagName)).toEqual(["DT", "DD"]);
      const [term, definition] = Array.from(row.children);
      expect(term.textContent).toBe(pairs[index][0]);
      expect(definition.textContent).toContain(pairs[index][1]);
      expect(term.closest("dl")).toBe(list);
      expect(definition.closest("dl")).toBe(list);
    });
  });
  it("renders all seven actual Backups owners including its lazy Hidden games Section", async () => {
    mount(<SettingsBackups />);
    await waitFor(() => expect(document.getElementById("hidden-games")).toBeTruthy());
    expectTargets(SETTINGS_SECTIONS.backups.map(section => section.id));
  });
  it("includes the nested catalog, library, Gateway and preview Sections in Randomizer", () => {
    mount(<SettingsRandomizer />); expectTargets(SETTINGS_SECTIONS.randomizer.map(section => section.id));
  });
  it("keeps the real player channel Section as a navigation target without connecting a provider", () => {
    mount(<SettingsPlayerChannels savedPulseIds={[]} profileDirty={false} onDirtyChange={() => {}} />);
    expectTargets(["player-channels"]);
  });
  it("keeps Voice's one actual Section without starting speech or saving", () => {
    mount(<SettingsVoice />); expectTargets(["voice-readout"]);
  });
});

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestoreSetupChecklist } from "../RestoreSetupChecklist";
import { SettingsImport } from "../SettingsImport";
import { ToastProvider } from "@/components/ui/Toast";

const h = vi.hoisted(() => ({ apiCall: vi.fn(), preferences: { data: {} as Record<string, unknown>, mutate: vi.fn() }, enabled: false, folderSync: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "token" }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => h.apiCall(...args), useApi: () => h.preferences }));
vi.mock("@/lib/instant/useInstantImport", () => ({ useInstantImport: () => ({ enabled: h.enabled }) }));
vi.mock("../SettingsImportPanel", () => ({ SettingsImportPanel: () => <p>Desktop agent controls</p> }));
vi.mock("@/components/instant/BrowserImportPanel", () => ({ BrowserImportPanel: () => <p>Browser import tools</p> }));
vi.mock("@/components/instant/FolderSyncCard", () => ({ FolderSyncCard: () => <p>Folder sync</p>, useFolderSync: () => h.folderSync() }));
vi.mock("@/components/instant/BrowserVsAgentTable", () => ({ BrowserVsAgentTable: () => <p>Compare imports</p> }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children, slug }: { children: React.ReactNode; slug: string }) => <a href={`/help/${slug}`}>{children}</a> }));
beforeEach(() => {
  h.apiCall.mockReset(); h.apiCall.mockResolvedValue({}); h.enabled = false; h.folderSync.mockReset();
  h.preferences = { data: { dismissedAt: "earlier", goals: ["stream"], downloadStartedAt: "keep" }, mutate: vi.fn().mockImplementation(async () => { h.preferences.data = { ...h.preferences.data, dismissedAt: null }; }) };
});
afterEach(cleanup);

describe("setup preferences", () => {
  it("restores only the dismissal field and links back to the dashboard", async () => {
    render(<ToastProvider><RestoreSetupChecklist /></ToastProvider>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Show the setup checklist again" })); });
    expect(h.apiCall.mock.lastCall?.[2]).toMatchObject({ method: "PUT", body: JSON.stringify({ dismissedAt: null }) });
    expect(h.preferences.data.goals).toEqual(["stream"]); expect(h.preferences.data.downloadStartedAt).toBe("keep");
    expect(screen.getByRole("link", { name: "Open your dashboard" }).getAttribute("href")).toBe("/app");
    expect((screen.getByRole("button", { name: "It's already showing" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps desktop controls available with the browser flag off", () => {
    const view = render(<SettingsImport />);
    expect(screen.getByText("Desktop agent controls")).toBeTruthy(); expect(screen.queryByText("Browser import tools")).toBeNull(); expect(h.folderSync).not.toHaveBeenCalled();
    h.enabled = true; view.rerender(<SettingsImport />);
    expect(screen.getByText("Browser import tools")).toBeTruthy(); expect(h.folderSync).toHaveBeenCalled();
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ owner: "a" as string | null, data: {}, save: vi.fn(), mutate: vi.fn(), success: vi.fn(), failure: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: !!fixture.owner, userId: fixture.owner, getToken: async () => `token:${fixture.owner}` }) }));
vi.mock("@/lib/clientApi", () => ({ API_BASE: "", useApi: () => ({ data: fixture.data, isLoading: false, mutate: fixture.mutate }), apiCall: (...args: unknown[]) => fixture.save(...args) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: { success: fixture.success, error: fixture.failure } }) }));
vi.mock("../OfficialPlatformConnections", () => ({ OfficialPlatformConnections: () => null }));
vi.mock("../ChatCommandsCard", () => ({ ChatCommandsCard: () => null }));
import { SettingsMultiChat } from "../SettingsMultiChat";
const open = () => fireEvent.click(screen.getByText("Game moments", { exact: true }));
const toggle = () => screen.getByRole("switch", { name: "Five or ten wins", hidden: true });
beforeEach(() => { fixture.owner = "a"; fixture.save.mockReset().mockResolvedValue({}); fixture.mutate.mockReset().mockResolvedValue({}); fixture.success.mockClear(); fixture.failure.mockClear(); });
afterEach(cleanup);
describe("Moment preferences in the real chat settings draft", () => {
  it("previews without saving, then includes the explicit opt-in in existing Save", async () => {
    render(<SettingsMultiChat token="a-token" />); open();
    fireEvent.click(screen.getByRole("button", { name: "Test Five or ten wins", hidden: true }));
    expect(screen.getByText("TEST · Local preview")).toBeTruthy(); expect(fixture.save).not.toHaveBeenCalled();
    fireEvent.click(toggle()); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save chat settings" })); });
    const [, path, init] = fixture.save.mock.calls[0]; expect(path).toBe("/v1/me/preferences/multichat");
    expect(JSON.parse(init.body).alerts.gameMoments).toMatchObject({ botPost: false, moments: { winStreak: { enabled: true } } });
    expect(fixture.success).toHaveBeenCalledWith("Chat settings saved", expect.anything());
  });
  it("drops a dirty preview and aborts held Save when the owner changes or signs out", async () => {
    let release!: () => void; fixture.save.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const view = render(<SettingsMultiChat token="a-token" />); open(); fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Test Five or ten wins", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Save chat settings" }));
    await waitFor(() => expect(fixture.save).toHaveBeenCalledOnce()); const init = fixture.save.mock.calls[0][2];
    fixture.owner = "b"; view.rerender(<SettingsMultiChat token="b-token" />);
    expect(init.signal.aborted).toBe(true); expect(screen.queryByText("TEST · Local preview")).toBeNull();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => release()); expect(fixture.success).not.toHaveBeenCalled(); expect(fixture.failure).not.toHaveBeenCalled();
    fixture.owner = null; view.rerender(<SettingsMultiChat token={null} />);
    expect(screen.getByText("Sign in to configure chat settings.")).toBeTruthy(); expect(screen.queryByRole("switch", { name: "Five or ten wins", hidden: true })).toBeNull();
  });
});

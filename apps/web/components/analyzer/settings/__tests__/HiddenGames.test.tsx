import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HiddenGames from "../HiddenGames";
const auth = vi.hoisted(() => ({ userId: "owner-a" as string | null, isLoaded: true, isSignedIn: true, getToken: vi.fn() }));
const api = vi.hoisted(() => ({ paths: [] as string[], mutate: vi.fn(), calls: vi.fn(), empty: false }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string) => {
    api.paths.push(path);
    const second = path.includes("cursor="), owner = auth.userId;
    return { data: { items: api.empty ? [] : second ? [{ gameId: `${owner}-pending`, pendingDeletion: true }] : [{ gameId: `${owner}-hidden`, map: "Synthetic hidden map", reason: "friend_played", opponent: "Synthetic rival" }], nextCursor: second || api.empty ? null : "next-cursor" }, isLoading: false, isPreviousData: false, mutate: api.mutate };
  }, apiCall: (...args: unknown[]) => api.calls(...args),
}));
beforeEach(() => { Object.assign(auth, { userId: "owner-a", isLoaded: true, isSignedIn: true }); auth.getToken.mockReset().mockResolvedValue("token-a"); api.paths.length = 0; api.empty = false; api.mutate.mockReset().mockResolvedValue(undefined); api.calls.mockReset().mockResolvedValue({ gameId: "owner-a-hidden", excluded: false }); });
afterEach(cleanup);
describe("private Hidden Games settings", () => {
  it("reads one paged owner endpoint, unhides a replay and restores focus outside the removed row", async () => {
    render(<HiddenGames />);
    expect(api.paths.at(-1)).toBe("/v1/games/hidden"); expect(screen.getByText("Friend played")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View game" }).getAttribute("href")).toBe("/app/game/owner-a-hidden");
    fireEvent.click(screen.getByRole("button", { name: "Unhide" }));
    await waitFor(() => expect(api.calls).toHaveBeenCalledTimes(1));
    expect(api.calls.mock.calls[0][1]).toBe("/v1/games/owner-a-hidden");
    expect(api.calls.mock.calls[0][2]).toMatchObject({ method: "PATCH", body: JSON.stringify({ excluded: false }) });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh hidden games" })));
  });
  it("paginates control records and offers only typed Retry deletion for a pending record", async () => {
    render(<HiddenGames />); fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(api.paths.at(-1)).toBe("/v1/games/hidden?cursor=next-cursor");
    expect(screen.queryByRole("link", { name: "View game" })).toBeNull(); expect(screen.queryByRole("button", { name: "Unhide" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry deletion…" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByRole("dialog")).getByText("owner-a-pending")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous page" })); expect(api.paths.at(-1)).toBe("/v1/games/hidden");
  });
  it("drops the previous account's page and open confirmation on an owner/loading/signout change", async () => {
    const view = render(<HiddenGames />); fireEvent.click(screen.getByRole("button", { name: "Next page" })); fireEvent.click(screen.getByRole("button", { name: "Retry deletion…" }));
    auth.userId = "owner-b"; view.rerender(<HiddenGames />);
    expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.queryByText(/owner-a/)).toBeNull(); expect(api.paths.at(-1)).toBe("/v1/games/hidden");
    auth.isLoaded = false; view.rerender(<HiddenGames />); expect(screen.queryByText("Synthetic hidden map")).toBeNull();
    Object.assign(auth, { isLoaded: true, isSignedIn: false, userId: null }); view.rerender(<HiddenGames />); expect(screen.queryByText("Hidden games")).toBeNull();
    await act(async () => {}); expect(api.calls).not.toHaveBeenCalled();
  });
  it("shows an explicit empty state with refresh and no mutation actions", () => {
    api.empty = true; render(<HiddenGames />); expect(screen.getByText("No hidden games or pending deletions on this page.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unhide" })).toBeNull();
  });
});

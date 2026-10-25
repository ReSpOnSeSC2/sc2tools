import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PracticeButton } from "./PracticeButton";

const h = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: true, userId: "a", getToken: vi.fn() }, assign: vi.fn(), mutate: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: h.mutate }) }));
vi.mock("@/lib/practiceAssignment", () => ({ assignPractice: (...args: unknown[]) => h.assign(...args) }));
vi.mock("@/lib/useGhostPractice", () => ({ useGhostPractice: () => ({ config: { v: 2, slots: {} }, loading: false, saving: false }) }));
const build = { name: "Blink opening", slug: "blink", race: "Protoss", vsRace: "Terran" };
const result = { target: { v: 1, name: "Blink opening", steps: [{ supply: null, name: "Gateway", t: 40 }] }, config: { v: 2, slots: {} }, source: "Saved reference build order" };
beforeEach(() => {
  localStorage.clear(); h.auth = { isLoaded: true, isSignedIn: true, userId: "a", getToken: vi.fn().mockResolvedValue("a-token") };
  h.mutate.mockReset().mockResolvedValue(undefined);
  h.assign.mockReset().mockImplementation(async (_input, _slot, getToken) => { await getToken(); return result; });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("shared Practice split button", () => {
  it("starts no per-card request and assigns the concrete default only on action", async () => {
    const parent = vi.fn(); render(<div onClick={parent}><PracticeButton build={build} privateBuild /></div>);
    expect(h.assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Practice in PvT" }));
    await screen.findByText(/Your Ghost URL updates automatically/);
    expect(h.assign).toHaveBeenCalledOnce(); expect(h.assign.mock.calls[0][1]).toBe("PvT");
    expect(parent).not.toHaveBeenCalled(); expect(h.mutate.mock.calls[0][0]).toEqual(["authenticated-api", "a", "/v1/me/preferences/ghost"]);
  });
  it("opens accessible matchup choices for the build's race and links settings", async () => {
    render(<PracticeButton build={build} />);
    fireEvent.click(screen.getByRole("button", { name: "Practice options for Blink opening" }));
    const dialog = await screen.findByRole("dialog"); expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["PvP", "PvT", "PvZ"]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "PvZ" } });
    fireEvent.click(screen.getByRole("button", { name: "Practice in PvZ" }));
    await waitFor(() => expect(h.assign).toHaveBeenCalledOnce()); expect(h.assign.mock.calls[0][1]).toBe("PvZ");
    expect(screen.getByRole("link", { name: "Open Ghost settings" }).getAttribute("href")).toBe("/settings?tab=overlay&section=look");
  });
  it("requires sign-in and never creates an anonymous browser-only assignment", async () => {
    h.auth = { ...h.auth, isSignedIn: false }; render(<PracticeButton build={build} />);
    fireEvent.click(screen.getByRole("button", { name: "Practice in PvT" }));
    expect((await screen.findByRole("link", { name: /Sign in to save/ })).getAttribute("href")).toBe("/sign-in"); expect(h.assign).not.toHaveBeenCalled();
  });
  it("cancels a held token at a same-user auth-loading boundary", async () => {
    let release!: (token: string) => void; h.auth.getToken.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const view = render(<PracticeButton build={build} />);
    fireEvent.click(screen.getByRole("button", { name: "Practice in PvT" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    h.auth = { ...h.auth, isLoaded: false }; view.rerender(<PracticeButton build={build} />);
    await act(async () => release("old-token"));
    expect(h.mutate).not.toHaveBeenCalled(); expect(screen.queryByText(/Practicing “/)).toBeNull();
    h.auth = { ...h.auth, isLoaded: true }; view.rerender(<PracticeButton build={build} />);
    expect((screen.getByRole("button", { name: "Practice in PvT" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("shows a failed save and lets the same explicit action retry", async () => {
    h.assign.mockRejectedValueOnce(new Error("Couldn't reach practice. Try again.")); render(<PracticeButton build={build} />);
    fireEvent.click(screen.getByRole("button", { name: "Practice in PvT" })); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Practice in PvT" })); await screen.findByText(/Your Ghost URL updates automatically/);
    expect(h.assign).toHaveBeenCalledTimes(2);
  });
});

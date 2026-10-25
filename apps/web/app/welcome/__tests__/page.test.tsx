import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingHelpers } from "@/components/onboarding/OnboardingShell";
import WelcomePage from "../page";

const h = vi.hoisted(() => ({ params: "", meReady: true, replace: vi.fn(), push: vi.fn(), apiCall: vi.fn(), mutate: vi.fn(), auth: { userId: "u1", isLoaded: true, isSignedIn: true, getToken: vi.fn() }, me: { agentPaired: false, games: { total: 0 }, onboarding: {} as Record<string, unknown> } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, replace: h.replace }), useSearchParams: () => new URLSearchParams(h.params) }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth, useUser: () => ({ isLoaded: true, user: { firstName: "Player" } }) }));
vi.mock("@/lib/clientApi", async original => ({ ...await original<typeof import("@/lib/clientApi")>(), apiCall: (...args: unknown[]) => h.apiCall(...args), useApi: () => ({ data: h.meReady ? h.me : undefined, mutate: h.mutate }) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
vi.mock("@/lib/instant/useInstantImport", () => ({ useInstantImport: () => ({ enabled: true, mode: "all", loading: false }) }));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: ({ slug, children }: { slug: string; children: React.ReactNode }) => <a href={"/help/" + slug}>{children}</a> }));
vi.mock("@/components/onboarding/OnboardingDownload", () => ({
  OnboardingDownload: ({ helpers, onBrowserImport }: { helpers: OnboardingHelpers; onBrowserImport?: () => void }) => <>
    <button type="button" onClick={helpers.next}>I downloaded it</button>
    {onBrowserImport ? <button type="button" onClick={onBrowserImport}>Import in your browser</button> : null}
  </>,
}));
vi.mock("@/components/onboarding/OnboardingPair", () => ({ OnboardingPair: ({ onContinue }: { onContinue: () => void }) => <button type="button" onClick={onContinue}>Continue to import</button> }));
vi.mock("@/components/onboarding/OnboardingImport", () => ({ OnboardingImport: ({ mode, onContinue }: { mode: string; onContinue?: () => void }) => <><h1 id="onboarding-step-heading" tabIndex={-1}>Import step: {mode}</h1><button onClick={onContinue}>Finish setup</button></> }));
vi.mock("@/components/onboarding/OnboardingDone", () => ({ OnboardingDone: () => <h1 id="onboarding-step-heading" tabIndex={-1}>You're set</h1> }));

beforeEach(() => { h.params = ""; h.meReady = true; h.me = { agentPaired: false, games: { total: 0 }, onboarding: {} }; h.apiCall.mockReset(); h.apiCall.mockResolvedValue({}); h.replace.mockReset(); h.mutate.mockReset(); });
beforeEach(() => { h.auth.userId = "u1"; h.auth.isLoaded = true; h.auth.isSignedIn = true; h.auth.getToken.mockReset().mockResolvedValue("token"); h.push.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function start() { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue to the download step" })); }); }

describe("resumable WelcomePage", () => {
  it("keeps an explicit URL continuation selected before the first account read settles", async () => {
    h.meReady = false; const view = render(<WelcomePage />);
    h.params = "step=done&next=%2Fguides%2Fpvt%2Fblink"; view.rerender(<WelcomePage />);
    expect(await screen.findByText("You're set")).toBeTruthy();
    h.meReady = true; h.me.agentPaired = true; view.rerender(<WelcomePage />);
    expect(screen.getByText("You're set")).toBeTruthy(); expect(h.replace).not.toHaveBeenCalled();
  });
  it("keeps browser import Back on Download and preserves the selected path in the URL", async () => {
    render(<WelcomePage />); await start();
    fireEvent.click(screen.getByRole("button", { name: "Import in your browser" }));
    expect(await screen.findByText("Import step: browser")).toBeTruthy();
    expect(h.replace.mock.lastCall?.[0]).toContain("step=import&mode=browser");
    fireEvent.click(screen.getByRole("button", { name: "Go to previous step" }));
    expect(screen.getByRole("button", { name: "I downloaded it" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I downloaded it" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to import" }));
    expect(await screen.findByText("Import step: agent")).toBeTruthy();
    expect(h.replace.mock.lastCall?.[0]).not.toContain("mode=browser");
  });
  it("resumes an already paired account at Import and exposes the completed Pair chip", async () => {
    h.me.agentPaired = true; render(<WelcomePage />);
    expect(await screen.findByText("Import step: agent")).toBeTruthy();
    const pair = screen.getByRole("button", { name: "Pair (complete)" });
    expect((pair as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(pair);
    expect(screen.getByRole("button", { name: "Continue to import" })).toBeTruthy();
  });
  it("resumes an account with games at Done and lets completed chips revisit setup", async () => {
    h.me.games.total = 12; render(<WelcomePage />);
    expect(await screen.findByText("You're set")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Welcome (complete)" }));
    expect(screen.getByRole("button", { name: "Upgrade my stream" })).toBeTruthy();
  });
  it("respects an explicit refreshed browser-import URL and subsequent URL navigation", async () => {
    h.params = "step=import&mode=browser"; h.me.games.total = 3;
    const view = render(<WelcomePage />);
    expect(await screen.findByText("Import step: browser")).toBeTruthy();
    h.params = "step=download&mode=browser"; view.rerender(<WelcomePage />);
    expect(screen.getByRole("button", { name: "I downloaded it" })).toBeTruthy();
  });
  it("saves goals as a patch without including stale checklist fields, and retains choices after failure", async () => {
    h.me.onboarding = { dismissedAt: "existing", downloadStartedAt: "earlier" };
    h.apiCall.mockRejectedValueOnce({ message: "Connection interrupted" });
    render(<WelcomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Upgrade my stream" }));
    await start();
    expect(screen.getByRole("alert").textContent).toBe("Connection interrupted");
    expect(screen.getByRole("button", { name: "Upgrade my stream" }).getAttribute("aria-pressed")).toBe("true");
    await start();
    await waitFor(() => expect(screen.getByRole("button", { name: "I downloaded it" })).toBeTruthy());
    expect(h.apiCall.mock.lastCall?.[2]).toMatchObject({ method: "PUT", body: JSON.stringify({ goals: ["improve", "stream"] }) });
  });
  it("offers Done from the import step without ending an active import", async () => {
    h.params = "step=import"; render(<WelcomePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish setup" }));
    expect(await screen.findByText("You're set")).toBeTruthy();
    expect(h.replace.mock.lastCall?.[0]).toContain("step=done");
  });
  it("aborts a pending preference save and prevents late navigation on unmount", async () => {
    let finish!: (value: object) => void;
    h.apiCall.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<WelcomePage />); await start();
    const signal = h.apiCall.mock.lastCall?.[2].signal as AbortSignal;
    const navigations = h.replace.mock.calls.length;
    view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { finish({}); });
    expect(h.replace.mock.calls).toHaveLength(navigations);
    expect(h.mutate).not.toHaveBeenCalled();
  });
  it.each(["loading", "signed-out"])("gates the wizard during %s even with a stale userId", state => {
    if (state === "loading") h.auth.isLoaded = false; else h.auth.isSignedIn = false;
    render(<WelcomePage />);
    expect(screen.queryByRole("button", { name: "Continue to the download step" })).toBeNull();
    expect(h.apiCall).not.toHaveBeenCalled(); expect(h.replace).not.toHaveBeenCalled();
  });
  it("fences a held goals JWT through auth-loading with the old userId retained", async () => {
    let release!: (token: string) => void; h.auth.getToken.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const sent = vi.fn(); h.apiCall.mockImplementation(async (getToken: () => Promise<string>, _path: string, init: RequestInit) => { const jwt = await getToken(); init.signal?.throwIfAborted(); sent(jwt); return {}; });
    const view = render(<WelcomePage />); await start(); const before = h.replace.mock.calls.length;
    h.auth.isLoaded = false; view.rerender(<WelcomePage />);
    await act(async () => release("later-session-token")); expect(sent).not.toHaveBeenCalled(); expect(h.mutate).not.toHaveBeenCalled(); expect(h.replace.mock.calls).toHaveLength(before);
  });
  it("ignores a held response on sign-out with stale userId", async () => {
    let release!: (value: object) => void; h.apiCall.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const view = render(<WelcomePage />); await start(); const before = h.replace.mock.calls.length;
    h.auth.isSignedIn = false; view.rerender(<WelcomePage />); await act(async () => release({}));
    expect(h.mutate).not.toHaveBeenCalled(); expect(h.replace.mock.calls).toHaveLength(before);
  });
  it("does not let an old A body clear a new A save after A→B→A", async () => {
    const bodies: Array<(value: object) => void> = []; h.apiCall.mockImplementation(() => new Promise(resolve => bodies.push(resolve)));
    const view = render(<WelcomePage />); await start(); h.auth.userId = "u2"; view.rerender(<WelcomePage />); h.auth.userId = "u1"; view.rerender(<WelcomePage />); await start();
    expect(bodies).toHaveLength(2); const before = h.replace.mock.calls.length;
    await act(async () => bodies[0]({})); expect(screen.getByRole("button", { name: "Continue to the download step" })).toHaveProperty("disabled", true); expect(h.replace.mock.calls).toHaveLength(before); expect(h.mutate).not.toHaveBeenCalled();
    await act(async () => bodies[1]({})); expect(screen.getByRole("button", { name: "I downloaded it" })).toBeTruthy(); expect(h.mutate).toHaveBeenCalledTimes(1);
  });
  it("a late cache acknowledgement cannot navigate a new account", async () => {
    let release!: (value: object) => void; h.mutate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const view = render(<WelcomePage />); await start(); await waitFor(() => expect(release).toBeTypeOf("function"));
    h.auth.userId = "u2"; view.rerender(<WelcomePage />); const before = h.replace.mock.calls.length;
    await act(async () => release({})); expect(h.replace.mock.calls).toHaveLength(before); expect(screen.getByRole("button", { name: "Continue to the download step" })).toHaveProperty("disabled", false);
  });
  it("bounds a held JWT, keeps goals and allows retry without a late request", async () => {
    const sent = vi.fn(); h.apiCall.mockImplementation(async (getToken: () => Promise<string>) => { sent(await getToken()); return {}; });
    render(<WelcomePage />); fireEvent.click(screen.getByRole("button", { name: "Upgrade my stream" })); vi.useFakeTimers();
    let release!: (value: string) => void; h.auth.getToken.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await start(); await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.getByRole("button", { name: "Continue to the download step" })).toHaveProperty("disabled", false); expect(screen.getByRole("button", { name: "Upgrade my stream" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => release("late")); expect(sent).not.toHaveBeenCalled(); vi.useRealTimers(); await start();
    expect(sent).toHaveBeenCalledTimes(1); expect(h.apiCall.mock.lastCall?.[2].body).toBe(JSON.stringify({ goals: ["improve", "stream"] }));
  });
  it("keeps the safe public continuation through goals navigation and Skip", async () => {
    h.params = "next=%2Fcommunity%2Fbuilds%2Fmacro"; render(<WelcomePage />); await start();
    expect(h.replace.mock.lastCall?.[0]).toContain("next=%2Fcommunity%2Fbuilds%2Fmacro"); fireEvent.click(screen.getByRole("button", { name: "Skip onboarding for now" }));
    expect(h.push).toHaveBeenCalledWith("/community/builds/macro");
  });
  it("retains public continuation when an expired setup session asks for sign-in", () => {
    h.params = "next=%2Fcommunity%2Fbuilds%2Fmacro"; h.auth.isSignedIn = false; render(<WelcomePage />);
    expect(screen.getByRole("link", { name: "Sign in to continue setup." }).getAttribute("href")).toBe("/sign-in?redirect_url=%2Fcommunity%2Fbuilds%2Fmacro");
  });
  it("cannot navigate or refresh from a late body after the continuation context changes", async () => {
    let release!: (value: object) => void; h.apiCall.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    h.params = "next=%2Fcommunity%2Fbuilds%2Fmacro"; const view = render(<WelcomePage />); await start();
    h.params = "next=%2Fguides%2FPvZ%2Fforge"; view.rerender(<WelcomePage />); const before = h.replace.mock.calls.length;
    await act(async () => release({})); expect(h.mutate).not.toHaveBeenCalled(); expect(h.replace.mock.calls).toHaveLength(before);
    expect(screen.getByRole("button", { name: "Continue to the download step" })).toHaveProperty("disabled", false);
  });
});

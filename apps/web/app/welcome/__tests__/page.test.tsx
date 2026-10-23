import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingHelpers } from "@/components/onboarding/OnboardingShell";
import WelcomePage from "../page";

const h = vi.hoisted(() => ({ params: "", replace: vi.fn(), push: vi.fn(), apiCall: vi.fn(), mutate: vi.fn(), me: { agentPaired: false, games: { total: 0 }, onboarding: {} as Record<string, unknown> } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, replace: h.replace }), useSearchParams: () => new URLSearchParams(h.params) }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: "u1", getToken: async () => "token" }), useUser: () => ({ isLoaded: true, user: { firstName: "Player" } }) }));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => h.apiCall(...args), useApi: () => ({ data: h.me, mutate: h.mutate }) }));
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

beforeEach(() => { h.params = ""; h.me = { agentPaired: false, games: { total: 0 }, onboarding: {} }; h.apiCall.mockReset(); h.apiCall.mockResolvedValue({}); h.replace.mockReset(); h.mutate.mockReset(); });
afterEach(cleanup);

async function start() { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue to the download step" })); }); }

describe("resumable WelcomePage", () => {
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
});

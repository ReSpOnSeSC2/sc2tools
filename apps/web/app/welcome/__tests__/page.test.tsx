/**
 * /welcome — which import Step 4 shows. "Skip the download — import in
 * your browser" opens it in browser mode; reaching it through Pair
 * (including Back from a browser import) is the agent path again. The
 * step components are MOCK stubs; the real OnboardingShell drives the
 * steps. Router, GA4 and the Instant Analysis gate are mocked.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingHelpers } from "@/components/onboarding/OnboardingShell";
import WelcomePage from "../page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: vi.fn() }));
vi.mock("@/lib/instant/useInstantImport", () => ({
  useInstantImport: () => ({ enabled: true, mode: "all", loading: false }),
}));
vi.mock("@/components/onboarding/OnboardingWelcome", () => ({
  OnboardingWelcome: ({ helpers }: { helpers: OnboardingHelpers }) => (
    <button type="button" onClick={helpers.next}>Get started</button>
  ),
}));
vi.mock("@/components/onboarding/OnboardingDownload", () => ({
  OnboardingDownload: ({ helpers, onBrowserImport }: { helpers: OnboardingHelpers; onBrowserImport?: () => void }) => (
    <>
      <button type="button" onClick={helpers.next}>I downloaded it</button>
      {onBrowserImport ? <button type="button" onClick={onBrowserImport}>Import in your browser</button> : null}
    </>
  ),
}));
vi.mock("@/components/onboarding/OnboardingPair", () => ({
  OnboardingPair: ({ onContinue }: { onContinue: () => void }) => (
    <button type="button" onClick={onContinue}>Continue</button>
  ),
}));
vi.mock("@/components/onboarding/OnboardingImport", () => ({
  OnboardingImport: ({ mode }: { mode: string }) => <p>Import step: {mode}</p>,
}));

afterEach(cleanup);

describe("WelcomePage import mode", () => {
  it("opens the browser import from the download step", () => {
    render(<WelcomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Import in your browser" }));
    expect(screen.getByText("Import step: browser")).toBeTruthy();
  });

  it("goes back to the agent import when the visitor continues through Pair", () => {
    render(<WelcomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    fireEvent.click(screen.getByRole("button", { name: "Import in your browser" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to previous step" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Import step: agent")).toBeTruthy();
  });
});

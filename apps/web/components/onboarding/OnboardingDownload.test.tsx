/**
 * OnboardingDownload — the "Skip the download — import in your browser"
 * button appears only when the page passes `onBrowserImport`. The
 * release-backed DownloadCard is a MOCK stub.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingDownload } from "./OnboardingDownload";
import type { OnboardingHelpers } from "./OnboardingShell";

vi.mock("./DownloadCard", () => ({ DownloadCard: () => <div data-testid="download-card" /> }));

function helpers(): OnboardingHelpers {
  return { next: vi.fn(), prev: vi.fn(), goTo: vi.fn(), isFirst: false, isLast: false, step: "download", index: 1 };
}

afterEach(cleanup);

describe("OnboardingDownload", () => {
  it("offers the browser path when enabled", () => {
    const onBrowserImport = vi.fn();
    render(<OnboardingDownload helpers={helpers()} onBrowserImport={onBrowserImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip the download — import in your browser" }));
    expect(onBrowserImport).toHaveBeenCalledTimes(1);
  });

  it("keeps the agent-only step otherwise", () => {
    render(<OnboardingDownload helpers={helpers()} />);
    expect(screen.queryByRole("button", { name: /import in your browser/i })).toBeNull();
    expect(screen.getByRole("button", { name: /continue to pairing/i })).toBeTruthy();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const auth = vi.hoisted(() => ({ signedIn: true }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: auth.signedIn }) }));
vi.mock("@/components/feedback/LazyReportIssueModal", () => ({
  LazyReportIssueModal: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Report form" /> : null),
}));

import { HelpSupportLine } from "../HelpSupportLine";

afterEach(() => {
  cleanup();
  auth.signedIn = true;
});

describe("HelpSupportLine panel (Settings → Help)", () => {
  it("leads with a Report a problem button and keeps the email as the fallback line", () => {
    render(<HelpSupportLine variant="panel" />);
    expect(screen.getByRole("heading", { name: "Still stuck?" })).toBeTruthy();
    const button = screen.getByRole("button", { name: "Report a problem" });
    const email = screen.getByRole("link", { name: "responsecoaching@gmail.com" });
    expect(email.getAttribute("href")).toBe("mailto:responsecoaching@gmail.com");
    expect(email.closest("p")?.textContent).toMatch(/^Or email responsecoaching@gmail\.com/);
    // The fallback sits under the button.
    expect(button.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "Report form" })).toBeTruthy();
  });

  it("offers only the email when signed out", () => {
    auth.signedIn = false;
    render(<HelpSupportLine variant="panel" />);
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
    expect(screen.getByRole("link", { name: "responsecoaching@gmail.com" }).closest("p")?.textContent).toMatch(/^Email /);
  });
});

describe("HelpSupportLine line", () => {
  it("is one sentence with the form link and the email", () => {
    render(<HelpSupportLine />);
    expect(screen.queryByRole("heading")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(screen.getByRole("dialog", { name: "Report form" })).toBeTruthy();
    expect(screen.getByText(/Still stuck\?/)).toBeTruthy();
  });
});

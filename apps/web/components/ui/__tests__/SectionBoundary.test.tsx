import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const harness = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: true },
  noClerk: false,
  pathname: "/app/opponents",
  captureException: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => {
    if (harness.noClerk) throw new Error("useAuth can only be used within <ClerkProvider />");
    return { ...harness.auth, getToken: async () => "token" };
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname }));
vi.mock("@/lib/sentry", () => ({ captureException: harness.captureException }));

import { SectionBoundary } from "../SectionBoundary";

let shouldThrow = true;
function Flaky() {
  if (shouldThrow) throw new Error("Cannot read properties of undefined (reading 'rows')");
  return <p>Section content</p>;
}

beforeEach(() => {
  shouldThrow = true;
  harness.noClerk = false;
  harness.auth = { isLoaded: true, isSignedIn: true };
  harness.pathname = "/app/opponents";
  harness.captureException.mockReset();
  harness.captureException.mockResolvedValue("evt_0123456789abcdef");
  // React logs caught render errors; keep the test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderCrashed() {
  render(
    <SectionBoundary label="the Daily Pulse strip">
      <Flaky />
    </SectionBoundary>,
  );
  // Let the Sentry promise resolve.
  await act(async () => {});
}

describe("SectionBoundary", () => {
  it("replaces a crashed section with a friendly message and reports it", async () => {
    await renderCrashed();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't show the Daily Pulse strip");
    expect(screen.getByText(/The rest of the page still works/)).toBeTruthy();
    expect(harness.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("rows") }));
  });

  it("re-renders the section on Try again", async () => {
    await renderCrashed();
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Section content")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the message and the Sentry event id under Details", async () => {
    await renderCrashed();
    const details = screen.getByText("Details").closest("details") as HTMLDetailsElement;
    expect(details.textContent).toContain("Cannot read properties of undefined (reading 'rows')");
    expect(details.textContent).toContain("evt_0123456789abcdef");
  });

  it("says when the error was not recorded", async () => {
    harness.captureException.mockResolvedValue(null);
    await renderCrashed();
    expect(screen.getByText("Not recorded")).toBeTruthy();
  });

  it("opens the report form prefilled with the page, error and event id", async () => {
    await renderCrashed();
    fireEvent.click(screen.getByRole("button", { name: "Report this problem" }));
    const subject = (await screen.findByLabelText("Subject")) as HTMLInputElement;
    expect(subject.value).toBe("Error in the Daily Pulse strip on /app/opponents");
    const message = screen.getByLabelText("Details", { selector: "textarea" }) as HTMLTextAreaElement;
    expect(message.value).toContain("Page: /app/opponents");
    expect(message.value).toContain("Error ID: evt_0123456789abcdef");
  });

  it("offers an email link to signed-out visitors", async () => {
    harness.auth = { isLoaded: true, isSignedIn: false };
    await renderCrashed();
    const link = screen.getByRole("link", { name: "Report this problem" });
    expect(link.getAttribute("href")).toMatch(/^mailto:/);
    expect(decodeURIComponent(link.getAttribute("href") ?? "")).toContain("Error ID: evt_0123456789abcdef");
  });

  it("still shows the message when the page has no account context", async () => {
    harness.noClerk = true;
    await renderCrashed();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't show the Daily Pulse strip");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Report this problem")).toBeNull();
  });

  it("offers no report action on overlay pages, which run without an account", async () => {
    harness.pathname = "/overlay/abc123";
    await renderCrashed();
    expect(screen.queryByRole("button", { name: "Report this problem" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Report this problem" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

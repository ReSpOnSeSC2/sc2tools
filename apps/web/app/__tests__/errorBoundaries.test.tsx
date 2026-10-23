import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

const harness = vi.hoisted(() => ({
  pathname: "/app/opponents/1-S2-1-99",
  auth: { isLoaded: true, isSignedIn: true },
  useAuth: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => {
    harness.useAuth();
    return harness.auth;
  },
}));
vi.mock("@/lib/sentry", () => ({ captureException: vi.fn(async () => undefined) }));
vi.mock("@/components/feedback/LazyReportIssueModal", () => ({
  LazyReportIssueModal: (props: { open: boolean; prefill?: { type?: string; subject?: string } }) =>
    props.open ? (
      <div role="dialog" aria-label="Report form" data-type={props.prefill?.type}>
        {props.prefill?.subject}
      </div>
    ) : null,
}));

import RouteError from "../error";
import GlobalError from "../global-error";

afterEach(() => {
  cleanup();
  harness.pathname = "/app/opponents/1-S2-1-99";
  harness.auth = { isLoaded: true, isSignedIn: true };
  harness.useAuth.mockReset();
});

function crash(digest?: string): Error & { digest?: string } {
  return Object.assign(new Error("boom"), digest ? { digest } : {});
}

describe("app/error.tsx", () => {
  it("prefills the report with the page and the error reference", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RouteError error={crash("4242")} reset={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Report this problem" }));
    const form = screen.getByRole("dialog", { name: "Report form" });
    expect(form.getAttribute("data-type")).toBe("problem");
    expect(form.textContent).toBe("Error on /app/opponents/1-S2-1-99 (ref 4242)");
  });

  it("offers an email carrying the reference to signed-out visitors", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    harness.auth = { isLoaded: true, isSignedIn: false };
    harness.pathname = "/community/builds/some-build";
    render(<RouteError error={crash("777")} reset={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Report this problem" })).toBeNull();
    const email = new URL(screen.getByRole("link", { name: "Email us about it" }).getAttribute("href")!);
    expect(email.protocol).toBe("mailto:");
    expect(email.searchParams.get("subject")).toBe("Error on /community/builds/some-build (ref 777)");
    expect(email.searchParams.get("body")).toContain("Error reference: 777");
  });

  it("never asks Clerk on the OBS browser-source pages, and hides their token", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    harness.pathname = "/overlay/secret-token/widget/scout";
    render(<RouteError error={crash("9")} reset={vi.fn()} />);
    expect(harness.useAuth).not.toHaveBeenCalled();
    const href = screen.getByRole("link", { name: "Email us about it" }).getAttribute("href")!;
    expect(decodeURIComponent(href)).toContain("/overlay/[redacted]/widget/scout");
    expect(href).not.toContain("secret-token");
  });
});

describe("app/global-error.tsx", () => {
  it("swaps 'report it from the app' for an email link with the digest", () => {
    const html = renderToStaticMarkup(<GlobalError error={crash("abc123")} reset={vi.fn()} />);
    expect(html).not.toContain("report it from the app");
    const href = /href="(mailto:[^"]+)"/.exec(html)?.[1].replace(/&amp;/g, "&");
    expect(href).toBeDefined();
    const url = new URL(href!);
    expect(url.pathname).toBe("responsecoaching@gmail.com");
    expect(url.searchParams.get("subject")).toBe("SC2 Tools error (ref abc123)");
    expect(html).toContain("Error reference: <code>abc123</code>");
  });
});

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const harness = vi.hoisted(() => ({ signedIn: false }));

vi.mock("@clerk/nextjs", () => ({
  SignedIn: ({ children }: { children: ReactNode }) => (harness.signedIn ? <>{children}</> : null),
  SignedOut: ({ children }: { children: ReactNode }) => (harness.signedIn ? null : <>{children}</>),
}));
vi.mock("@/components/feedback/ReportIssueLauncher", () => ({ ReportIssueLauncher: () => null }));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} />,
}));

import { Footer, STATUS_PAGE_URL, YOUTUBE_CHANNEL_URL, productLinks, resourcesLinks } from "../Footer";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  harness.signedIn = false;
});

describe("Footer resources", () => {
  it("links the build guides first while guides are on", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "1");
    render(<Footer />);
    const guides = screen.getByRole("link", { name: "Build guides" });
    expect(guides.getAttribute("href")).toBe("/guides");
    expect(resourcesLinks(true)[0]).toEqual({ href: "/guides", label: "Build guides" });
  });

  it("hides the build guides link while guides are off", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    render(<Footer />);
    expect(screen.queryByRole("link", { name: "Build guides" })).toBeNull();
    expect(resourcesLinks(false).some((link) => link.href === "/guides")).toBe(false);
    expect(screen.getByRole("link", { name: "Stream Studio crash course" }).getAttribute("href")).toBe("/stream-studio/learn");
  });

  it("links the help center and its getting-started article", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: "Help" }).getAttribute("href")).toBe("/help");
    expect(screen.getByRole("link", { name: "Getting started" }).getAttribute("href")).toBe("/help/getting-started");
  });

  it("opens the channel's build-order videos in a new tab and says so", () => {
    render(<Footer />);
    const youtube = screen.getByRole("link", { name: "YouTube build videos (opens in a new tab)" });
    expect(youtube.getAttribute("href")).toBe(YOUTUBE_CHANNEL_URL);
    expect(YOUTUBE_CHANNEL_URL).toBe("https://www.youtube.com/@ReSpOnSeSC2");
    expect(youtube.getAttribute("target")).toBe("_blank");
    expect(youtube.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("Footer audiences", () => {
  it("never sends a visitor to a sign-in wall", () => {
    render(<Footer />);
    expect(screen.queryByRole("link", { name: "Devices" })).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in");
  });

  it("shows Devices to signed-in players and drops the Sign in link", () => {
    harness.signedIn = true;
    render(<Footer />);
    expect(screen.getByRole("link", { name: "Devices" }).getAttribute("href")).toBe("/devices");
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("links the in-browser analyzer only while Instant Analysis is open to everyone", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
    render(<Footer />);
    expect(screen.getByRole("link", { name: "Analyze replays in your browser" }).getAttribute("href")).toBe("/try");
    expect(productLinks(true).map((link) => link.href).slice(0, 2)).toEqual(["/#analyze", "/try"]);
    expect(productLinks(false).some((link) => link.href === "/try")).toBe(false);
  });

  it("hides the in-browser analyzer link while it is admin-only", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "admins");
    render(<Footer />);
    expect(screen.queryByRole("link", { name: "Analyze replays in your browser" })).toBeNull();
  });
});

describe("Footer status link", () => {
  it("is a neutral link to the status page, not a live health light", () => {
    const { container } = render(<Footer />);
    const status = screen.getByRole("link", { name: "System status (opens in a new tab)" });
    expect(status.getAttribute("href")).toBe(STATUS_PAGE_URL);
    expect(status.getAttribute("target")).toBe("_blank");
    expect(status.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.querySelector(".animate-ping, .motion-safe\\:animate-ping")).toBeNull();
    expect(status.querySelector(".bg-success")).toBeNull();
  });
});

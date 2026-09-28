import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/feedback/ReportIssueLauncher", () => ({ ReportIssueLauncher: () => null }));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} />,
}));

import { Footer, YOUTUBE_CHANNEL_URL, resourcesLinks } from "../Footer";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
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
  });

  it("always links the channel's build-order videos as an external link", () => {
    render(<Footer />);
    const youtube = screen.getByRole("link", { name: "YouTube build videos" });
    expect(youtube.getAttribute("href")).toBe(YOUTUBE_CHANNEL_URL);
    expect(YOUTUBE_CHANNEL_URL).toBe("https://www.youtube.com/@ReSpOnSeSC2");
    expect(youtube.getAttribute("rel")).toContain("noopener");
  });
});

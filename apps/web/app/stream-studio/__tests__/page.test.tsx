import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import StreamStudioRoute, { metadata } from "../page";
import { StreamStudioPage } from "@/components/landing/StreamStudioPage";
import { PRODUCT_FACTS } from "@/lib/productFacts";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: false }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("/stream-studio", () => {
  it("targets the overlay searches in its title, canonical and social card", () => {
    expect(metadata.title).toEqual({ absolute: "SC2 Overlay for OBS: free StarCraft II Stream Studio | SC2 Tools" });
    expect(metadata.alternates?.canonical).toBe("/stream-studio");
    expect(String(metadata.description)).toContain(`${PRODUCT_FACTS.overlayWidgets} copy-and-paste widgets`);
  });

  it("puts the searched-for phrase in its only H1 and links to the download", () => {
    render(<StreamStudioPage tryEnabled={false} />);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toContain("StarCraft II overlays for OBS");
    const downloads = screen.getAllByRole("link", { name: /Download the free agent/ });
    expect(downloads[0].getAttribute("href")).toBe("/download");
    expect(screen.getByRole("link", { name: /New here\? Take the Stream Studio crash course/ }).getAttribute("href")).toBe("/stream-studio/learn");
    expect(screen.getByRole("link", { name: /Learn the setup and explore every widget/ }).getAttribute("href")).toBe("/stream-studio/learn");
    expect(screen.queryByRole("link", { name: /analyze a replay in your browser/ })).toBeNull();
  });

  it("offers the in-browser analyzer only when /try is public", () => {
    vi.stubEnv("NEXT_PUBLIC_INSTANT_IMPORT", "all");
    render(StreamStudioRoute());
    expect(screen.getByRole("link", { name: /analyze a replay in your browser/ }).getAttribute("href")).toBe("/try");
  });
});

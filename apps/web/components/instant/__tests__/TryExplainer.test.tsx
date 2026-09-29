import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { TryExplainer } from "@/components/instant/TryExplainer";
import { MAX_TRY_FILES } from "@/lib/instant/fileIntake";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("TryExplainer", () => {
  it("describes the analyzer with the real replay cap and folder paths", () => {
    render(<TryExplainer />);
    expect(
      screen.getByRole("heading", { level: 2, name: "A free StarCraft II replay analyzer that runs in your browser" }),
    ).toBeTruthy();
    expect(screen.getByText(new RegExp(`Add up to ${MAX_TRY_FILES} replays`))).toBeTruthy();
    expect(screen.getByText("Documents\\StarCraft II\\Accounts")).toBeTruthy();
    expect(screen.getByText("~/Library/Application Support/Blizzard/StarCraft II/Accounts")).toBeTruthy();
  });

  it("publishes free WebApplication structured data", () => {
    const { container } = render(<TryExplainer />);
    const script = container.querySelector('script[type="application/ld+json"]');
    const data = JSON.parse(script?.textContent ?? "{}");
    expect(data["@type"]).toBe("WebApplication");
    expect(data.offers).toEqual({ "@type": "Offer", price: "0", priceCurrency: "USD" });
  });

  it("links the guides only while they are published", () => {
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "on");
    render(<TryExplainer />);
    expect(screen.getByRole("link", { name: "build-order guides" }).getAttribute("href")).toBe("/guides");
    cleanup();
    vi.stubEnv("NEXT_PUBLIC_GUIDES_ENABLED", "");
    render(<TryExplainer />);
    expect(screen.queryByRole("link", { name: "build-order guides" })).toBeNull();
  });
});

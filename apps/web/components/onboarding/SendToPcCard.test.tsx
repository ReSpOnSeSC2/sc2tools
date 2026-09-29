import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { gaEventMock } = vi.hoisted(() => ({ gaEventMock: vi.fn() }));
vi.mock("@/lib/analytics/gtag", () => ({ gaEvent: (...args: unknown[]) => gaEventMock(...args) }));

import { SendToPcCard, sendToPcLink, sendToPcMailto } from "./SendToPcCard";
import { isMobilePlatform } from "./useIsMobileDevice";

afterEach(() => {
  cleanup();
  gaEventMock.mockReset();
});

describe("isMobilePlatform", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", 5, true],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36", 5, true],
    // iPadOS reports a desktop Mac user agent; touch points give it away.
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15", 5, true],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15", 0, false],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36", 0, false],
  ])("%s (touch %i) → %s", (ua, touch, expected) => {
    expect(isMobilePlatform(ua, touch)).toBe(expected);
  });
});

describe("SendToPcCard", () => {
  it("links to the download page with send_to_pc attribution", () => {
    expect(sendToPcLink("email")).toBe(
      "https://sc2tools.com/download?utm_source=sc2tools&utm_medium=email&utm_campaign=send_to_pc",
    );
    expect(sendToPcLink("copy")).toContain("utm_medium=share");
    const mailto = sendToPcMailto();
    expect(mailto.startsWith("mailto:?subject=")).toBe(true);
    expect(decodeURIComponent(mailto)).toContain(sendToPcLink("email"));
  });

  it("offers email and copy, and tracks the email tap", () => {
    render(<SendToPcCard />);
    const email = screen.getByRole("link", { name: /Email me the link/ });
    expect(email.getAttribute("href")).toBe(sendToPcMailto());
    email.addEventListener("click", (event) => event.preventDefault()); // jsdom can't open mailto:
    fireEvent.click(email);
    expect(gaEventMock).toHaveBeenCalledWith("download_link_sent", { method: "email" });
    expect(screen.getByRole("button", { name: /Copy link/ })).toBeTruthy();
  });
});

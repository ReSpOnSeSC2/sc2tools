import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { UrlRow } from "../SettingsOverlay";

afterEach(cleanup);

describe("UrlRow", () => {
  it("keeps a long Ghost Build URL on one line and wraps its actions together", () => {
    const url =
      "https://sc2tools.com/overlay/token/widget/ghost-build?ghost=" +
      "x".repeat(8_000);
    const { container, getByRole } = render(
      <UrlRow url={url} compact onTest={vi.fn()} />,
    );

    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe(url);
    expect(code!.getAttribute("title")).toBe(url);

    const classes = code!.className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining(["grow", "basis-full", "sm:basis-48", "truncate"]),
    );
    expect(classes).not.toContain("break-all");

    const copyButton = getByRole("button", { name: "Copy" });
    const testButton = getByRole("button", { name: "Test" });
    expect(copyButton.parentElement).toBe(testButton.parentElement);
    expect(copyButton.parentElement!.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["flex", "flex-none", "gap-2"]),
    );
  });
});

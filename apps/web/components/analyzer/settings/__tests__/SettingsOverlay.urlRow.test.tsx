import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { UrlRow } from "../OverlayUrlRow";

afterEach(cleanup);

describe("UrlRow", () => {
  it("clamps a long Ghost Build URL to two copyable lines beside its actions", async () => {
    const url =
      "https://sc2tools.com/overlay/token/widget/ghost-build?ghost=" +
      "x".repeat(8_000);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container, getByRole } = render(
      <UrlRow url={url} compact onTest={vi.fn()} />,
    );

    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe(url);
    expect(code!.getAttribute("title")).toBe(url);
    expect(code!.getAttribute("aria-label")).toBe("Widget Browser Source URL");
    expect(code!.getAttribute("tabindex")).toBe("0");

    const classes = code!.className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "line-clamp-2",
        "w-full",
        "min-w-0",
        "max-w-full",
        "select-all",
        "break-all",
        "whitespace-normal",
      ]),
    );
    expect(classes).not.toContain("truncate");

    expect(code!.parentElement!.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "grid",
        "min-w-0",
        "max-w-full",
        "sm:grid-cols-[minmax(0,1fr)_auto]",
      ]),
    );

    const copyButton = getByRole("button", { name: "Copy" });
    const testButton = getByRole("button", { name: "Test" });
    expect(copyButton.parentElement).toBe(testButton.parentElement);
    expect(copyButton.parentElement!.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "flex",
        "flex-none",
        "gap-2",
        "sm:justify-self-end",
      ]),
    );

    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
  });
});

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
    expect(code!.textContent).toBe("https://sc2tools.com/overlay/••••••/widget/ghost-build");
    expect(code!.getAttribute("title")).not.toContain("token");
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
    fireEvent.click(getByRole("button", { name: "Reveal" })); expect(code!.textContent).toBe(url);
    fireEvent.click(getByRole("button", { name: "Hide URL" })); expect(code!.textContent).not.toContain("token");
  });

  it("selects the full URL when clipboard copy fails, and never reveals a newly changed token", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("unavailable")) } });
    const first = "https://sc2tools.com/dock/first-private", second = "https://sc2tools.com/dock/second-private";
    const view = render(<UrlRow url={first} compact />); fireEvent.click(view.getByRole("button", { name: "Copy" }));
    const field = await view.findByRole("textbox", { name: "Copy this private URL" }) as HTMLInputElement;
    expect(field.value).toBe(first);
    // The fallback mounts before its passive effect focuses/selects it.
    await waitFor(() => { expect(document.activeElement).toBe(field); expect(field.selectionStart).toBe(0); expect(field.selectionEnd).toBe(first.length); });
    view.rerender(<UrlRow url={second} compact />); expect(view.queryByRole("textbox")).toBeNull(); expect(view.container.querySelector("code")!.textContent).not.toContain("second-private");
    fireEvent.click(view.getByRole("button", { name: "Reveal" })); view.rerender(<UrlRow url={first} compact />); expect(view.container.querySelector("code")!.textContent).not.toContain("first-private");
  });
});

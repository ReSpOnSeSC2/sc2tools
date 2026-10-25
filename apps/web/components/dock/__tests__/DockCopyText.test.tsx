import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DockCopyText } from "../DockCopyText";

const clipboard = (value: unknown) => Object.defineProperty(navigator, "clipboard", { configurable: true, value });
afterEach(() => { cleanup(); vi.useRealTimers(); clipboard(undefined); });
describe("Dock manual copy recovery", () => {
  it("copies the full private URL without exposing it before a fallback is needed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); clipboard({ writeText });
    render(<DockCopyText value="https://example.invalid/dock/private-bearer" label="Copy dock URL" />);
    expect(document.body.textContent).not.toContain("private-bearer");
    fireEvent.click(screen.getByRole("button", { name: "Copy dock URL" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith("https://example.invalid/dock/private-bearer"); expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("selects a read-only URL when the clipboard is absent and lets the user hide it", async () => {
    clipboard(undefined); render(<DockCopyText value="https://example.invalid/dock/private" label="Copy dock URL" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy dock URL" }));
    const field = await screen.findByRole("textbox", { name: "Copy dock URL manually" }) as HTMLInputElement;
    expect(field.readOnly).toBe(true); expect(document.activeElement).toBe(field); expect(field.selectionStart).toBe(0); expect(field.selectionEnd).toBe(field.value.length);
    fireEvent.click(screen.getByRole("button", { name: "Hide copy field" })); expect(screen.queryByRole("textbox")).toBeNull(); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy dock URL" }));
  });
  it("preserves multiline timestamps in the selected fallback after clipboard rejection", async () => {
    clipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) }); const value = "00:01 — First\n00:25 — Second";
    render(<DockCopyText value={value} label="Copy timestamps" />); fireEvent.click(screen.getByRole("button", { name: "Copy timestamps" }));
    const field = await screen.findByRole("textbox", { name: "Copy timestamps manually" }) as HTMLTextAreaElement;
    expect(field.value).toBe(value); expect(document.activeElement).toBe(field); expect(field.selectionEnd).toBe(value.length);
  });
  it("cannot reveal or mark a new value copied after an old request finishes", async () => {
    let finish!: () => void; clipboard({ writeText: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) });
    const view = render(<DockCopyText value="old private" label="Copy dock URL" />); fireEvent.click(screen.getByRole("button", { name: "Copy dock URL" }));
    view.rerender(<DockCopyText value="new private" label="Copy dock URL" />); await act(async () => finish());
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull(); expect(screen.queryByRole("textbox")).toBeNull(); expect(document.body.textContent).not.toContain("old private");
  });
  it("bounds a hung clipboard and leaves a selected manual fallback", async () => {
    vi.useFakeTimers(); clipboard({ writeText: vi.fn(() => new Promise<void>(() => {})) });
    render(<DockCopyText value="timestamp list" label="Copy timestamps" />); fireEvent.click(screen.getByRole("button", { name: "Copy timestamps" }));
    await act(async () => vi.advanceTimersByTimeAsync(3001));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("timestamp list"); expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
});

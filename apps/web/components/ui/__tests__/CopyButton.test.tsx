import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CopyButton } from "../CopyButton";
import { ToastProvider } from "../Toast";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("uses the Clipboard API only after a click and announces success outside any Toast provider", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<CopyButton text="https://example.test/replay">Copy replay link</CopyButton>);
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Copy replay link" }));
  expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Copied");
  expect(writeText).toHaveBeenCalledOnce(); expect(writeText).toHaveBeenCalledWith("https://example.test/replay");
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("shows a labeled visible readonly selected fallback, and Escape returns focus to Copy", async () => {
  vi.stubGlobal("navigator", {});
  render(<CopyButton text="Exact copy value" fallbackLabel="Replay link">Copy replay link</CopyButton>);
  const button = screen.getByRole("button", { name: "Copy replay link" });
  fireEvent.click(button);
  const input = await screen.findByRole<HTMLInputElement>("textbox", { name: "Replay link" });
  expect(input.value).toBe("Exact copy value"); expect(input.readOnly).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(input.value.length);
  expect(screen.getByRole("status").textContent).toContain("Copy the selected text manually");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull(); expect(document.activeElement).toBe(button);
});

it("preserves multiline copy text in a selected textarea instead of stripping line breaks", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("Denied"); } } });
  const text = "First line\nSecond line";
  render(<CopyButton text={text}>Copy report</CopyButton>);
  fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
  const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Copy this text" });
  expect(input.tagName).toBe("TEXTAREA"); expect(input.value).toBe(text);
  expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(text.length);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy report" }));
});

it("does not treat an empty exact copy value as the absence of fallback", async () => {
  vi.stubGlobal("navigator", {});
  render(<CopyButton text="" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  const input = await screen.findByRole<HTMLInputElement>("textbox");
  expect(input.value).toBe(""); expect(input.readOnly).toBe(true);
});

it("keeps Button disabled semantics and emits the existing optional success toast", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = render(<ToastProvider><CopyButton text="Value" disabled /></ToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Copy" })); expect(writeText).not.toHaveBeenCalled();
  view.rerender(<ToastProvider><CopyButton text="Value" successMessage="Replay link copied" /></ToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Notifications" })).getByText("Replay link copied")).toBeTruthy());
});

it.each(["text", "scopeKey"])("changing %s retires the old result without showing Copied or a stale fallback", async changed => {
  let resolve!: () => void;
  const pending = new Promise<void>(yes => { resolve = yes; });
  vi.stubGlobal("navigator", { clipboard: { writeText: () => pending } });
  const view = render(<CopyButton text="Old" scopeKey="one" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  view.rerender(<CopyButton text={changed === "text" ? "New" : "Old"} scopeKey={changed === "scopeKey" ? "two" : "one"} />);
  await act(async () => { resolve(); await pending; });
  await waitFor(() => expect((screen.getByRole("button", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
});

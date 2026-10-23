import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GameClockLink } from "../GameClockLink";

const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => { cleanup(); if (original) Object.defineProperty(navigator, "clipboard", original); else Reflect.deleteProperty(navigator, "clipboard"); });

it("copies the clock's current link and announces success", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<GameClockLink time={222} getHref={() => "https://example.test/app/game/g1?t=222#macro"} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy link at 3:42" }));
  await screen.findByText("Link copied");
  expect(writeText).toHaveBeenCalledWith("https://example.test/app/game/g1?t=222#macro");
});

it("offers a focused, selected link when clipboard permission is denied", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  const href = "https://example.test/app/game/g1?t=100";
  render(<GameClockLink time={100} getHref={() => href} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy link at 1:40" }));
  const input = await screen.findByRole("textbox", { name: "Copy this replay link" }) as HTMLInputElement;
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.value).toBe(href); expect(input.readOnly).toBe(true);
  expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(href.length);
  expect(screen.queryByText("Link copied")).toBeNull();
});

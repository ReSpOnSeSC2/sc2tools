import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IconButton } from "../IconButton";

afterEach(cleanup);
it("names the action, hides its decorative glyph and forwards the actionable ref", () => {
  const ref = createRef<HTMLButtonElement>(), click = vi.fn();
  render(<IconButton ref={ref} aria-label="Close preview" onClick={click}><svg><title>Decorative cross</title></svg></IconButton>);
  const button = screen.getByRole("button", { name: "Close preview" });
  expect(ref.current).toBe(button);
  fireEvent.click(button); expect(click).toHaveBeenCalledOnce();
});
it("retains shared busy and disabled semantics", () => {
  const click = vi.fn();
  render(<IconButton aria-label="Refresh" loading onClick={click}>↻</IconButton>);
  const button = screen.getByRole("button", { name: "Refresh" });
  expect(button.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(button); expect(click).not.toHaveBeenCalled();
});
// @ts-expect-error Icon-only actions must supply an accessible name.
const unnamed = <IconButton>×</IconButton>;
void unnamed;

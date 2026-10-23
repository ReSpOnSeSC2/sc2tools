import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthShell } from "../AuthShell";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
it("keeps lead, widget and marketing in DOM order with a phone disclosure", async () => {
  const { container } = render(<AuthShell lead="Lead value" marketing={<p>Marketing details</p>}>{() => <form aria-label="Sign in"><input aria-label="Email" /></form>}</AuthShell>);
  const lead = screen.getByText("Lead value"); const form = await screen.findByRole("form"); const marketing = screen.getByText("Marketing details");
  expect(lead.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(form.compareDocumentPosition(marketing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.querySelector('[class*="flex-col-reverse"]')).toBeNull();
  const details = marketing.closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("Why sign up?"));
  await waitFor(() => expect(details.open).toBe(true));
});
it("opens the same marketing node as the right column on desktop", async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  render(<AuthShell lead="Lead" marketing={<p>Marketing</p>}>{() => <input aria-label="Email" />}</AuthShell>);
  await screen.findByRole("textbox");
  expect(screen.getByText("Marketing").closest("details")?.open).toBe(true);
  expect(screen.getAllByText("Marketing")).toHaveLength(1);
});

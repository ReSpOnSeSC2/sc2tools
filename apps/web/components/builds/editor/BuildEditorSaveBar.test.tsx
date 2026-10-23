import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuildEditorSaveBar } from "./BuildEditorSaveBar";
afterEach(cleanup);
it("keeps the complete save error in a wrapping callout above the actions", () => {
  const message = "The build could not be saved. ".repeat(25);
  render(<BuildEditorSaveBar ruleCount={1} saving={false} saveError={message} onCancel={vi.fn()} onSave={vi.fn()} />);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe(message);
  expect(alert.className).toContain("break-words");
  expect(alert.className).toContain("max-h-28");
  expect(alert.className).not.toContain("truncate");
  expect(alert.compareDocumentPosition(screen.getByRole("button", { name: "Save build" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

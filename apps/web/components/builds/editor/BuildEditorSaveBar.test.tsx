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
it("blocks both write actions while a rule needs a known action", () => {
  const save = vi.fn();
  render(<BuildEditorSaveBar ruleCount={2} saving={false} saveError={null} ruleError="Rule 2: Unknown action." onCancel={vi.fn()} onSave={save} />);
  expect((screen.getByRole("button", { name: "Save build" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Save & re-match" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("Rule 2");
  expect(save).not.toHaveBeenCalled();
});

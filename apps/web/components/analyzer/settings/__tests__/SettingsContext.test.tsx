/**
 * SettingsContext keeps unsaved state per form: a tab is dirty while any
 * form on it is, so a clean form never clears another form's edits, and
 * the shell re-renders as forms change.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SettingsContextProvider, usePublishDirty, useSettingsContext } from "../SettingsContext";

function Form({ dirty }: { dirty: boolean }) {
  usePublishDirty("overlay", dirty);
  return null;
}

function Probe() {
  const ctx = useSettingsContext();
  return (
    <p>
      overlay {ctx.isDirty("overlay") ? "dirty" : "clean"} · any {ctx.hasAnyDirty() ? "yes" : "no"}
    </p>
  );
}

function tree(a: boolean, b: boolean | null, onDirtyChange?: (s: Record<string, boolean>) => void) {
  return (
    <SettingsContextProvider onDirtyChange={onDirtyChange}>
      <Form dirty={a} />
      {b === null ? null : <Form dirty={b} />}
      <Probe />
    </SettingsContextProvider>
  );
}

afterEach(cleanup);

describe("SettingsContext", () => {
  it("keeps a tab dirty while any of its forms is", () => {
    const onDirtyChange = vi.fn();
    const view = render(tree(false, false, onDirtyChange));
    expect(screen.getByText("overlay clean · any no")).toBeTruthy();

    view.rerender(tree(true, false, onDirtyChange));
    expect(screen.getByText("overlay dirty · any yes")).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith({ overlay: true });

    // The other form turning dirty, then the first saving: still dirty.
    view.rerender(tree(true, true, onDirtyChange));
    view.rerender(tree(false, true, onDirtyChange));
    expect(screen.getByText("overlay dirty · any yes")).toBeTruthy();

    // The last dirty form goes away (its tab unmounted): clean.
    view.rerender(tree(false, null, onDirtyChange));
    expect(screen.getByText("overlay clean · any no")).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith({ overlay: false });
  });

  it("is a no-op outside Settings", () => {
    expect(() => render(<Form dirty />)).not.toThrow();
  });
});

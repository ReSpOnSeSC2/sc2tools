import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCommandSearchShortcuts } from "../useCommandSearchShortcuts";
import { focusPageSearchTarget, hasPageSearchTarget, usePageSearchShortcut } from "../usePageSearchShortcut";

type TargetMode = "visible" | "disabled" | "fieldset" | "details" | "summary" | "hidden" | "inert"
  | "aria-hidden" | "display" | "visibility" | "opacity";
const owner = {}, route = {};

function PageTarget({ mode = "visible", label = "Page search" }: { mode?: TargetMode; label?: string }) {
  const ref = useRef<HTMLInputElement>(null); usePageSearchShortcut(ref);
  const input = <input ref={ref} aria-label={label} disabled={mode === "disabled"} />;
  if (mode === "fieldset") return <fieldset disabled>{input}</fieldset>;
  if (mode === "details") return <details><summary>Closed search</summary>{input}</details>;
  if (mode === "summary") return <details><summary>{input}</summary><p>Closed body</p></details>;
  return <div hidden={mode === "hidden"} inert={mode === "inert"} aria-hidden={mode === "aria-hidden" || undefined}
    style={{ display: mode === "display" ? "none" : undefined,
      visibility: mode === "visibility" ? "hidden" : undefined, opacity: mode === "opacity" ? 0 : undefined }}>
    {input}
  </div>;
}

function Global({ search }: { search: () => void }) {
  useCommandSearchShortcuts({ owner, route, path: "/app", navigation: [], search, help: () => {}, navigate: () => {} });
  return <button type="button">Outside field</button>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("one local slash owner", () => {
  it.each([true, false])("local search wins with page registered first=%s", pageFirst => {
    const search = vi.fn();
    render(pageFirst ? <><PageTarget /><Global search={search} /></> : <><Global search={search} /><PageTarget /></>);
    screen.getByRole("button", { name: "Outside field" }).focus();
    expect(fireEvent.keyDown(document, { key: "/" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Page search" }));
    expect(search).not.toHaveBeenCalled();
  });

  it("skips a later hidden registration and focuses the real eligible input", () => {
    render(<><PageTarget label="Eligible" /><PageTarget label="Hidden" mode="hidden" /></>);
    expect(hasPageSearchTarget()).toBe(true);
    expect(focusPageSearchTarget()).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Eligible" }));
  });

  it("keeps a closed-details summary target eligible", () => {
    render(<PageTarget mode="summary" />);
    expect(focusPageSearchTarget()).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Page search" }));
  });

  it("requires a successful focus before claiming slash and otherwise falls back globally", () => {
    const search = vi.fn(); render(<><PageTarget /><Global search={search} /></>);
    const input = screen.getByRole("textbox", { name: "Page search" });
    vi.spyOn(input, "focus").mockImplementation(() => {});
    screen.getByRole("button", { name: "Outside field" }).focus();
    expect(focusPageSearchTarget()).toBe(false);
    fireEvent.keyDown(document, { key: "/" });
    expect(search).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(input);
  });
});

describe("ineligible targets and cleanup", () => {
  it.each(["disabled", "fieldset", "details", "hidden", "inert", "aria-hidden",
    "display", "visibility", "opacity"] as const)("does not let %s search swallow the global slash", mode => {
    const search = vi.fn(); render(<><PageTarget mode={mode} /><Global search={search} /></>);
    screen.getByRole("button", { name: "Outside field" }).focus();
    expect(hasPageSearchTarget()).toBe(false);
    fireEvent.keyDown(document, { key: "/" });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("removes the local target/listener on unmount and does not focus a detached input", () => {
    const view = render(<PageTarget />), old = screen.getByRole("textbox");
    expect(hasPageSearchTarget()).toBe(true);
    view.unmount();
    expect(hasPageSearchTarget()).toBe(false);
    expect(focusPageSearchTarget()).toBe(false);
    expect(fireEvent.keyDown(document, { key: "/" })).toBe(true);
    expect(document.activeElement).not.toBe(old);
  });

  it("local slash leaves active editing and already handled events alone", () => {
    render(<><PageTarget /><textarea aria-label="Draft" /></>);
    const draft = screen.getByRole("textbox", { name: "Draft" }); draft.focus();
    fireEvent.keyDown(document, { key: "/" });
    expect(document.activeElement).toBe(draft);
    draft.blur();
    const handled = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    handled.preventDefault(); document.dispatchEvent(handled);
    expect(document.activeElement).not.toBe(screen.getByRole("textbox", { name: "Page search" }));
  });
});

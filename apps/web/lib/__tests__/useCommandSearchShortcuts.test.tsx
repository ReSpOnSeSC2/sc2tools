import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, startTransition, useLayoutEffect, useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFocusScope, removeFocusScope } from "../a11y/focusScopes";
import { useCommandSearchShortcuts } from "../useCommandSearchShortcuts";

const navigation = [
  { key: "today", href: "/app", label: "Today" },
  { key: "settings", href: "/settings", label: "Settings" },
];
const owner = {}, route = {};
type Callbacks = { search: () => void; help: () => void; navigate: (entry: (typeof navigation)[number]) => void };

function Harness({ callbacks, viewer = owner, visit = route, children }: {
  callbacks: Callbacks; viewer?: object; visit?: object; children?: ReactNode;
}) {
  useCommandSearchShortcuts({ owner: viewer, route: visit, path: "/app", navigation, ...callbacks });
  return <><button type="button">Page control</button>{children}</>;
}

function Scope() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const record = registerFocusScope(ref.current!, false, document.activeElement);
    return () => { removeFocusScope(record); };
  }, []);
  return <div ref={ref}>Registered nonmodal scope</div>;
}

const pending = new Promise<void>(() => {});
function Suspended({ callbacks: calls, blocked }: { callbacks: Callbacks; blocked: boolean }) {
  useCommandSearchShortcuts({ owner, route, path: "/app", navigation, ...calls });
  if (blocked) throw pending;
  return <button type="button">Committed page</button>;
}

function callbacks() { return { search: vi.fn(), help: vi.fn(), navigate: vi.fn() }; }
function key(value: string, options: KeyboardEventInit = {}) {
  return fireEvent.keyDown(document, { key: value, ...options });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("global search shortcut dispatch", () => {
  it("opens Ctrl/Cmd-K, slash and help outside fields and admits only known g destinations", () => {
    const calls = callbacks(); render(<Harness callbacks={calls} />); screen.getByRole("button").focus();
    expect(key("k", { ctrlKey: true })).toBe(false);
    expect(key("k", { metaKey: true })).toBe(false);
    expect(key("/")).toBe(false);
    expect(calls.search).toHaveBeenCalledTimes(3);
    key("?"); expect(calls.help).toHaveBeenCalledTimes(1);
    key("g"); key("t"); expect(calls.navigate).toHaveBeenCalledWith(navigation[0]);
    key("g"); key("r"); expect(calls.navigate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { repeat: true }, { isComposing: true }, { altKey: true }, { shiftKey: true },
  ])("does not hijack modified/repeated/composing Cmd-K %#", modifiers => {
    const calls = callbacks(); render(<Harness callbacks={calls} />);
    key("k", { ctrlKey: true, ...modifiers });
    expect(calls.search).not.toHaveBeenCalled();
  });

  it("respects an earlier key handler's preventDefault", () => {
    const calls = callbacks(); render(<Harness callbacks={calls} />);
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault(); document.dispatchEvent(event);
    expect(calls.search).not.toHaveBeenCalled();
  });
});

describe("editing and focus layer ownership", () => {
  it.each(["input", "textarea", "select", "editable"])("leaves focused %s editing alone", kind => {
    const calls = callbacks();
    const field = kind === "input" ? <input aria-label="Editing" /> : kind === "textarea"
      ? <textarea aria-label="Editing" /> : kind === "select" ? <select aria-label="Editing"><option>A</option></select>
        : <div role="textbox" contentEditable suppressContentEditableWarning tabIndex={0} aria-label="Editing">
          <span>Nested</span></div>;
    render(<Harness callbacks={calls}>{field}</Harness>);
    const editing = screen.getByLabelText("Editing"); editing.focus();
    key("k", { ctrlKey: true }); key("/"); key("?"); key("g"); key("t");
    expect(calls.search).not.toHaveBeenCalled(); expect(calls.help).not.toHaveBeenCalled();
    expect(calls.navigate).not.toHaveBeenCalled(); expect(document.activeElement).toBe(editing);
  });

  it("checks the editable event-target ancestor even when activeElement is outside it", () => {
    const calls = callbacks(); render(<Harness callbacks={calls}>
      <div contentEditable suppressContentEditableWarning><span data-testid="nested">Text</span></div>
    </Harness>);
    screen.getByRole("button").focus();
    fireEvent.keyDown(screen.getByTestId("nested"), { key: "k", ctrlKey: true });
    expect(calls.search).not.toHaveBeenCalled();
  });

  it.each(["dialog", "menu", "listbox"])("yields to visible fallback role=%s", role => {
    const calls = callbacks(); render(<Harness callbacks={calls}><div role={role}>Layer</div></Harness>);
    key("k", { ctrlKey: true }); key("/"); key("?");
    expect(calls.search).not.toHaveBeenCalled(); expect(calls.help).not.toHaveBeenCalled();
  });

  it("yields to native dialogs and registered nonmodal scopes, but ignores hidden layers", () => {
    const calls = callbacks(), view = render(<Harness callbacks={calls}><dialog open>Native</dialog></Harness>);
    key("k", { ctrlKey: true }); expect(calls.search).not.toHaveBeenCalled();
    view.rerender(<Harness callbacks={calls}><Scope /></Harness>);
    key("k", { ctrlKey: true }); expect(calls.search).not.toHaveBeenCalled();
    view.rerender(<Harness callbacks={calls}><div role="dialog" hidden>Hidden</div></Harness>);
    key("k", { ctrlKey: true }); expect(calls.search).toHaveBeenCalledTimes(1);
  });
});

describe("g-prefix lifetimes and cleanup", () => {
  it.each(["owner", "route"])("retires pending g through %s A-B-A", changed => {
    const calls = callbacks(), first = {}, second = {}, third = {};
    const visit = (token: object) => <Harness callbacks={calls}
      viewer={changed === "owner" ? token : owner} visit={changed === "route" ? token : route} />;
    const view = render(visit(first)); key("g");
    view.rerender(visit(second)); view.rerender(visit(third)); key("t");
    expect(calls.navigate).not.toHaveBeenCalled();
    key("g"); key("t"); expect(calls.navigate).toHaveBeenCalledTimes(1);
  });

  it.each(["popstate", "hashchange"])("retires pending g on same-path %s", kind => {
    const calls = callbacks(); render(<Harness callbacks={calls} />);
    key("g"); window.dispatchEvent(new Event(kind)); key("t");
    expect(calls.navigate).not.toHaveBeenCalled();
  });

  it("expires g, clears it on an incompatible key, and uses only committed replacement callbacks", () => {
    const time = vi.spyOn(Date, "now").mockReturnValue(1_000), old = callbacks(), current = callbacks();
    const view = render(<Harness callbacks={old} />);
    key("g"); time.mockReturnValue(2_001); key("t"); expect(old.navigate).not.toHaveBeenCalled();
    key("g"); key("x"); key("t"); expect(old.navigate).not.toHaveBeenCalled();
    view.rerender(<Harness callbacks={current} />);
    key("k", { ctrlKey: true }); expect(current.search).toHaveBeenCalledTimes(1);
    expect(old.search).not.toHaveBeenCalled();
  });

  it("removes both keyboard and browser-navigation listeners on unmount", () => {
    const calls = callbacks(), view = render(<Harness callbacks={calls} />);
    key("g"); view.unmount();
    window.dispatchEvent(new Event("popstate")); key("t"); key("k", { ctrlKey: true });
    expect(calls.navigate).not.toHaveBeenCalled(); expect(calls.search).not.toHaveBeenCalled();
  });
});

it("does not publish a suspended uncommitted callback over the visible committed shortcut owner", () => {
  const before = callbacks(), uncommitted = callbacks();
  const view = render(<Suspense fallback={<p>Loading page</p>}>
    <Suspended callbacks={before} blocked={false} /></Suspense>);
  act(() => startTransition(() => view.rerender(
    <Suspense fallback={<p>Loading page</p>}><Suspended callbacks={uncommitted} blocked /></Suspense>,
  )));
  screen.getByRole("button", { name: "Committed page" }).focus();
  key("k", { ctrlKey: true });
  expect(before.search).toHaveBeenCalledTimes(1);
  expect(uncommitted.search).not.toHaveBeenCalled();
});

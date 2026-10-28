import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MACRO_OVERVIEW_QUERY, useMacroOverviewMode } from "../useMacroOverviewMode";

let matches = false;
const listeners = new Set<() => void>();
const query = vi.fn();
function Mode({ requested = true }: { requested?: boolean }) {
  const fitted = useMacroOverviewMode(requested);
  return <div>{fitted ? "Fitted modal overview" : "Normal timeline layout"}</div>;
}

beforeEach(() => {
  matches = false; listeners.clear(); query.mockClear();
  vi.stubGlobal("matchMedia", (value: string) => {
    query(value);
    return { get matches() { return matches; }, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("modal overview responsive admission", () => {
  it("keeps normal desktop layout and admits the narrow-or-coarse media result", () => {
    const view = render(<Mode />);
    expect(screen.getByText("Normal timeline layout")).toBeTruthy();
    expect(query).toHaveBeenCalledWith(MACRO_OVERVIEW_QUERY);
    act(() => { matches = true; for (const listener of listeners) listener(); });
    expect(screen.getByText("Fitted modal overview")).toBeTruthy();
    act(() => { matches = false; for (const listener of listeners) listener(); });
    expect(screen.getByText("Normal timeline layout")).toBeTruthy();
    view.unmount(); expect(listeners.size).toBe(0);
  });

  it("does not change full-game or review callers even on a narrow/coarse screen", () => {
    matches = true;
    render(<Mode requested={false} />);
    expect(screen.getByText("Normal timeline layout")).toBeTruthy();
    expect(listeners.size).toBe(0);
  });

  it("keeps the normal usable layout when a media API is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<Mode />);
    expect(screen.getByText("Normal timeline layout")).toBeTruthy();
  });
});

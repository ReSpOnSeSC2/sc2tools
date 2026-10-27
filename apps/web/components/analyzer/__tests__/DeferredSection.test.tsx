import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeferredSection } from "../DeferredSection";

function observerFixture() {
  let callback: IntersectionObserverCallback;
  const observe = vi.fn(), disconnect = vi.fn(), options = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(next: IntersectionObserverCallback, value: IntersectionObserverInit) { callback = next; options(value); }
    observe = observe;
    disconnect = disconnect;
  });
  return { observe, disconnect, options, notify: (near: boolean) => act(() => callback([{ isIntersecting: near } as IntersectionObserverEntry], {} as IntersectionObserver)) };
}

function StatefulChart({ near }: { near: boolean }) {
  const [draft, setDraft] = useState("initial");
  return <label>Chart choice<input value={draft} onChange={(event) => setDraft(event.target.value)} /><output aria-label="Near viewport">{String(near)}</output></label>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("deferred chart admission", () => {
  it("reserves space without mounting children and retains the same controls after leaving", () => {
    const observer = observerFixture();
    const view = render(<DeferredSection label="Chart" minHeight={420}>{({ isNearViewport }) => <StatefulChart near={isNearViewport} />}</DeferredSection>);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect((view.container.firstElementChild as HTMLElement).style.minHeight).toBe("420px");
    expect(observer.options).toHaveBeenCalledWith({ rootMargin: "400px 0px" });
    observer.notify(false);
    expect(screen.queryByRole("textbox")).toBeNull();
    observer.notify(true);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "keep my selection" } });
    observer.notify(false);
    expect(screen.getByRole("textbox")).toBe(input);
    expect((input as HTMLInputElement).value).toBe("keep my selection");
    expect(screen.getByLabelText("Near viewport").textContent).toBe("false");
    observer.notify(true);
    expect(screen.getByRole("textbox")).toBe(input);
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    observer.notify(true);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("admits explicit intent without pretending an offscreen chart is near forever", () => {
    const observer = observerFixture();
    const child = ({ isNearViewport }: { isNearViewport: boolean }) => <StatefulChart near={isNearViewport} />;
    const view = render(<DeferredSection label="Chart">{child}</DeferredSection>);
    view.rerender(<DeferredSection label="Chart" activationRequest={1}>{child}</DeferredSection>);
    const input = screen.getByRole("textbox");
    expect(screen.getByLabelText("Near viewport").textContent).toBe("false");
    fireEvent.change(input, { target: { value: "intent selection" } });
    view.rerender(<DeferredSection label="Chart" activationRequest={0}>{child}</DeferredSection>);
    observer.notify(false);
    expect(screen.getByRole("textbox")).toBe(input);
    expect((input as HTMLInputElement).value).toBe("intent selection");
  });

  it("offers manual activation before observer delivery", () => {
    observerFixture();
    render(<DeferredSection label="My chart"><p>Measured chart</p></DeferredSection>);
    fireEvent.click(screen.getByRole("button", { name: "Load My chart" }));
    expect(screen.getByText("Measured chart")).toBeTruthy();
  });

  it.each(["missing", "throws"])("renders usable content when the observer %s", (mode) => {
    vi.stubGlobal("IntersectionObserver", mode === "missing" ? undefined : class { constructor() { throw new Error("Observer unavailable"); } });
    render(<DeferredSection label="Chart">{({ isNearViewport }) => <StatefulChart near={isNearViewport} />}</DeferredSection>);
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.getByLabelText("Near viewport").textContent).toBe("true");
  });
});

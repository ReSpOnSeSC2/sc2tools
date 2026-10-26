import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsSectionNav, SettingsSectionsReady } from "../SettingsSectionNav";
import { SECTION_WAIT_MS } from "../revealSectionAnchor";

const sections = [{ id: "setup", label: "Setup" }, { id: "theme", label: "Theme" }, { id: "tokens", label: "Tokens" }];
const originalScroll = HTMLElement.prototype.scrollIntoView;
const records: { callback: IntersectionObserverCallback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn> }[] = [];
function Harness({ onNavigate = vi.fn(), hash = "#setup" }: { onNavigate?: (href: string) => void; hash?: string }) {
  const scope = useRef<HTMLDivElement>(null);
  return <><div id="theme">Outside chrome target</div><div ref={scope} data-testid="scope">
    <section id="tokens">Shared tokens before the private body</section>
    <SettingsSectionNav tab="overlay" sections={sections} scope={scope} hash={hash} onNavigate={onNavigate} />
    <div><section id="setup">Actual setup</section><section id="theme">Actual theme</section></div>
  </div></>;
}
beforeEach(() => {
  records.length = 0;
  window.history.replaceState(null, "", "/settings?tab=overlay&ref=kept");
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { records.push({ callback, observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() }); }
    observe = (target: Element) => records.at(-1)!.observe(target);
    unobserve = (target: Element) => records.at(-1)!.unobserve(target);
    disconnect = () => records.at(-1)!.disconnect();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); HTMLElement.prototype.scrollIntoView = originalScroll; window.history.replaceState(null, "", "/"); });
function intersect(target: Element, top = 115) {
  act(() => records[0].callback([{ target, isIntersecting: true, boundingClientRect: { top } } as IntersectionObserverEntry], {} as IntersectionObserver));
}

it("observes only active scoped targets, including shared controls before the private body", () => {
  render(<Harness />);
  const scope = screen.getByTestId("scope");
  expect(records[0].observe.mock.calls.map(call => call[0])).toEqual(sections.map(section => scope.querySelector(`[id="${section.id}"]`)));
  expect(records[0].observe).not.toHaveBeenCalledWith(document.querySelector("#theme"));
});
it("passive observations change current link/select without navigation, reveal, focus or history writes", () => {
  const navigate = vi.fn(), scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  render(<Harness onNavigate={navigate} />);
  const select = screen.getByRole("combobox", { name: "On this page" }); select.focus();
  const href = window.location.href, focused = document.activeElement;
  intersect(screen.getByTestId("scope").querySelector('[id="theme"]')!);
  expect((select as HTMLSelectElement).value).toBe("theme");
  expect(screen.getByRole("link", { name: "Theme" }).getAttribute("aria-current")).toBe("location");
  expect(navigate).not.toHaveBeenCalled(); expect(scroll).not.toHaveBeenCalled();
  expect(window.location.href).toBe(href); expect(document.activeElement).toBe(focused);
});
it("sends explicit desktop and native-select choices through Shell while modified links remain native", () => {
  const navigate = vi.fn(); render(<Harness onNavigate={navigate} />);
  const link = screen.getByRole("link", { name: "Theme" });
  fireEvent.click(link, { ctrlKey: true }); expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(link); expect(navigate).toHaveBeenLastCalledWith("/settings?tab=overlay&ref=kept#theme");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "tokens" } });
  expect(navigate).toHaveBeenLastCalledWith("/settings?tab=overlay&ref=kept#tokens");
});
it("discovers an admitted late target for a bounded interval and retires observers/callbacks", async () => {
  vi.useFakeTimers(); const view = render(<Harness />);
  const scope = screen.getByTestId("scope"), original = scope.querySelector('[id="theme"]')!;
  const replacement = document.createElement("section"); replacement.id = "theme";
  await act(async () => { original.replaceWith(replacement); await Promise.resolve(); });
  expect(records[0].unobserve).toHaveBeenCalledWith(original); expect(records[0].observe).toHaveBeenCalledWith(replacement);
  await act(async () => { await vi.advanceTimersByTimeAsync(SECTION_WAIT_MS); });
  const afterDeadline = document.createElement("section"); afterDeadline.id = "theme";
  await act(async () => { replacement.replaceWith(afterDeadline); await Promise.resolve(); });
  expect(records[0].observe.mock.calls.some(([target]) => target === afterDeadline)).toBe(false);
  view.unmount(); expect(records[0].disconnect).toHaveBeenCalledOnce();
  intersect(afterDeadline); expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull();
});

function MountedHarness({ ready = false, owner = "a" }: { ready?: boolean; owner?: string }) {
  const scope = useRef<HTMLDivElement>(null);
  return <div ref={scope} data-testid="mounted-scope">
    <SettingsSectionNav key={owner} tab="profile" sections={sections} scope={scope} hash="#theme"
      onNavigate={() => { throw new Error("Readiness must not navigate"); }} targetPolicy="mounted" minimumSections={3} />
    <div><SettingsSectionsReady revision={ready} /><input aria-label="Local draft" defaultValue="saved" />
      <section id="setup">Setup</section><section id="tokens">Tokens</section>{ready ? <section id="theme">Theme</section> : null}</div>
  </div>;
}

it("rearms one bounded window after actual late readiness without replacing a dirty body or revealing it", async () => {
  vi.useFakeTimers(); const scroll = vi.fn(); HTMLElement.prototype.scrollIntoView = scroll;
  window.history.replaceState(null, "", "/settings?tab=profile#theme");
  const view = render(<MountedHarness />), draft = screen.getByRole("textbox", { name: "Local draft" });
  fireEvent.change(draft, { target: { value: "unsaved" } }); draft.focus();
  expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(SECTION_WAIT_MS + 1); });
  view.rerender(<MountedHarness ready />);
  expect(screen.getByRole("navigation", { name: "On this page" })).toBeTruthy();
  expect(records).toHaveLength(1);
  expect(records[0].observe.mock.calls.some(([target]) => target === screen.getByTestId("mounted-scope").querySelector('[id="theme"]'))).toBe(true);
  expect(screen.getByRole("textbox", { name: "Local draft" })).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe("unsaved"); expect(document.activeElement).toBe(draft);
  expect(window.location.hash).toBe("#theme"); expect(scroll).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(SECTION_WAIT_MS + 1); });
  view.rerender(<MountedHarness />);
  expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull();
  expect(window.location.hash).toBe("#theme"); expect(screen.getByRole("textbox")).toBe(draft);
  expect(scroll).not.toHaveBeenCalled();
});

it("retires mounted-only owner A→B→A observers and ignores their queued callbacks", () => {
  const view = render(<MountedHarness ready owner="a" />);
  const old = records[0], target = screen.getByTestId("mounted-scope").querySelector('[id="setup"]')!;
  view.rerender(<MountedHarness ready owner="b" />); view.rerender(<MountedHarness ready owner="a" />);
  const select = screen.getByRole("combobox", { name: "On this page" });
  expect((select as HTMLSelectElement).value).toBe("theme");
  act(() => old.callback([{ target, isIntersecting: true, boundingClientRect: { top: 112 } } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect((select as HTMLSelectElement).value).toBe("theme");
  view.unmount();
  act(() => records.at(-1)!.callback([{ target, isIntersecting: true, boundingClientRect: { top: 112 } } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(screen.queryByRole("navigation")).toBeNull();
});

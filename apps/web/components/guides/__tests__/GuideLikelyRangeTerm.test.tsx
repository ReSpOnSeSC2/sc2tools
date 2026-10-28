import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Term as RealTerm } from "@/components/ui/Term";
import { Modal } from "@/components/ui/Modal";
import { GUIDE_STATS_LEGEND } from "@/lib/guides/guideCopy";
import { GuideLikelyRangeTerm } from "../GuideLikelyRangeTerm";

const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../loadGuideLegendTerm", () => ({ loadGuideLegendTerm: () => loader.load() }));
const copy = { label: GUIDE_STATS_LEGEND.rangeLabel, loadingLabel: GUIDE_STATS_LEGEND.rangeLoading,
  errorLabel: GUIDE_STATS_LEGEND.rangeUnavailable, retryLabel: GUIDE_STATS_LEGEND.rangeRetry };
function heldTerm() {
  let resolve!: (term: typeof RealTerm) => void;
  const promise = new Promise<typeof RealTerm>(done => { resolve = done; });
  return { promise, resolve };
}
function Legend({ modal = false }: { modal?: boolean }) {
  return <><details><summary>How to read these numbers</summary><GuideLikelyRangeTerm {...copy} /></details>
    <button type="button">Outside action</button>
    <Modal open={modal} onClose={() => {}} title="Later dialog"><button type="button">Later action</button></Modal></>;
}
function expand() {
  const details = screen.getByText("How to read these numbers").closest("details")!;
  details.open = true; fireEvent(details, new Event("toggle")); return details;
}
beforeEach(() => { loader.load.mockReset(); loader.load.mockResolvedValue(RealTerm); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("guide legend Term code admission", () => {
  it("keeps readable text without importing controls or rendering a pretend trigger while collapsed", () => {
    render(<Legend />);
    expect(screen.getByText(copy.label).className).toContain("decoration-dotted");
    expect(loader.load).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "About Likely range", hidden: true })).toBeNull();
    expect(screen.queryByRole("status", { hidden: true })).toBeNull();
  });

  it("loads the real Term once on native expansion and retains its actual InfoTip/Help/Escape behavior", async () => {
    render(<Legend />); const details = expand();
    const trigger = await screen.findByRole("button", { name: "About Likely range" });
    expect(loader.load).toHaveBeenCalledTimes(1);
    trigger.focus(); fireEvent.click(trigger);
    const tip = await screen.findByRole("dialog", { name: "About Likely range" });
    expect(await within(tip).findByText(/uncertainty around a guide's recorded win rate/)).toBeTruthy();
    expect(within(tip).getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe("/help/glossary#likely-range");
    fireEvent.keyDown(document, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    details.open = false; fireEvent(details, new Event("toggle")); expand();
    expect(loader.load).toHaveBeenCalledTimes(1);
  });

  it("truthfully reports held code and never opens a tip or steals focus when a closed legend's code arrives", async () => {
    const held = heldTerm(); loader.load.mockReturnValue(held.promise);
    render(<Legend />); const details = expand();
    expect(screen.getByRole("status").textContent).toBe(copy.loadingLabel);
    expect(screen.queryByRole("button", { name: "About Likely range" })).toBeNull();
    const summary = screen.getByText("How to read these numbers"); summary.focus();
    details.open = false; fireEvent(details, new Event("toggle"));
    await act(async () => { held.resolve(RealTerm); });
    expect(details.open).toBe(false); expect(document.activeElement).toBe(summary);
    expect(screen.queryByRole("dialog")).toBeNull(); expand();
    expect(screen.getByRole("button", { name: "About Likely range" })).toBeTruthy();
    expect(loader.load).toHaveBeenCalledTimes(1);
  });

  it("recovers a failed code import through explicit Retry and focuses only the real ready trigger", async () => {
    const held = heldTerm(); loader.load.mockRejectedValueOnce(new Error("Held code unavailable")).mockReturnValueOnce(held.promise);
    render(<Legend />); expand();
    expect((await screen.findByRole("alert")).textContent).toBe(copy.errorLabel);
    const retry = screen.getByRole("button", { name: copy.retryLabel }); retry.focus(); fireEvent.click(retry);
    expect(screen.getByRole("status").textContent).toBe(copy.loadingLabel);
    await act(async () => { held.resolve(RealTerm); });
    const trigger = screen.getByRole("button", { name: "About Likely range" });
    expect(document.activeElement).toBe(trigger); expect(loader.load).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retires a timed-out load until explicit Retry, and ignores its later resolution", async () => {
    vi.useFakeTimers(); const held = heldTerm(); loader.load.mockReturnValueOnce(held.promise).mockResolvedValueOnce(RealTerm);
    render(<Legend />); expand();
    act(() => vi.advanceTimersByTime(8_000));
    expect(screen.getByRole("alert").textContent).toBe(copy.errorLabel);
    await act(async () => { held.resolve(RealTerm); });
    expect(screen.getByRole("alert").textContent).toBe(copy.errorLabel);
    expect(screen.queryByRole("button", { name: "About Likely range" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.retryLabel }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "About Likely range" })).toBeTruthy();
    expect(loader.load).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the current Retry when its explicit retry rejects", async () => {
    loader.load.mockRejectedValueOnce(new Error("Unavailable")).mockRejectedValueOnce(new Error("Retry unavailable"));
    render(<Legend />); expand(); await screen.findByRole("alert");
    const previous = screen.getByRole("button", { name: copy.retryLabel }); previous.focus(); fireEvent.click(previous);
    expect(screen.queryByRole("button", { name: copy.retryLabel })).toBeNull();
    await screen.findByRole("alert");
    const current = screen.getByRole("button", { name: copy.retryLabel });
    expect(current).not.toBe(previous); expect(document.activeElement).toBe(current);
    expect(loader.load).toHaveBeenCalledTimes(2);
  });

  it("returns focus to the current Retry when its explicit retry times out, ignoring its late result", async () => {
    vi.useFakeTimers(); const held = heldTerm();
    loader.load.mockRejectedValueOnce(new Error("Unavailable")).mockReturnValueOnce(held.promise);
    render(<Legend />); expand(); await act(async () => {});
    const previous = screen.getByRole("button", { name: copy.retryLabel }); previous.focus(); fireEvent.click(previous);
    expect(screen.queryByRole("button", { name: copy.retryLabel })).toBeNull();
    act(() => vi.advanceTimersByTime(8_000));
    const current = screen.getByRole("button", { name: copy.retryLabel });
    expect(current).not.toBe(previous); expect(document.activeElement).toBe(current);
    await act(async () => { held.resolve(RealTerm); });
    expect(screen.getByRole("alert").textContent).toBe(copy.errorLabel);
    expect(document.activeElement).toBe(current); expect(loader.load).toHaveBeenCalledTimes(2);
  });

  it("does not take retry focus back from a newer modal", async () => {
    const held = heldTerm(); loader.load.mockRejectedValueOnce(new Error("Unavailable")).mockReturnValueOnce(held.promise);
    const view = render(<Legend />); expand(); await screen.findByRole("alert");
    const retry = screen.getByRole("button", { name: copy.retryLabel }); retry.focus(); fireEvent.click(retry);
    view.rerender(<Legend modal />);
    const later = screen.getByRole("button", { name: "Later action" }); later.focus();
    await act(async () => { held.resolve(RealTerm); });
    expect(document.activeElement).toBe(later);
    expect(screen.queryByRole("dialog", { name: "About Likely range" })).toBeNull();
  });
});

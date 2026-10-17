import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Modal } from "../Modal";
import { lockBodyScroll } from "@/lib/bodyScrollLock";

function Drilldown() {
  const [parentOpen, setParentOpen] = useState(true);
  const [reviewOpen, setReviewOpen] = useState(false);
  return (
    <Modal open={parentOpen} onClose={() => setParentOpen(false)} title="Game list">
      <button onClick={() => setReviewOpen(true)}>Ask for a review</button>
      <Modal open={reviewOpen} onClose={() => setReviewOpen(false)} title="Review request">
        <textarea aria-label="Question" />
        <button>Post request</button>
      </Modal>
    </Modal>
  );
}

function openReview() {
  render(<Drilldown />);
  act(() => { vi.runAllTimers(); });
  const opener = screen.getByRole("button", { name: "Ask for a review" });
  opener.focus();
  fireEvent.click(opener);
  act(() => { vi.runAllTimers(); });
  return { opener, dialog: screen.getByRole("dialog", { name: "Review request" }) };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.style.overflow = "";
});

describe("layered modal behavior", () => {
  it("Escape closes only the review, restores its opener, and keeps the game list locked", () => {
    vi.useFakeTimers();
    const { opener, dialog } = openReview();
    const input = within(dialog).getByRole("textbox", { name: "Question" });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Review request" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Game list" })).toBeTruthy();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(opener, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("traps forward and backward Tab inside the child dialog", () => {
    vi.useFakeTimers();
    const { dialog } = openReview();
    const close = within(dialog).getByRole("button", { name: "Close" });
    const submit = within(dialog).getByRole("button", { name: "Post request" });
    submit.focus();
    fireEvent.keyDown(submit, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(submit);
  });

  it("does not steal typing focus when a parent replaces its close callback", () => {
    vi.useFakeTimers();
    const previousClose = vi.fn();
    const nextClose = vi.fn();
    const { rerender } = render(
      <Modal open onClose={previousClose} title="Review request"><textarea aria-label="Question" /></Modal>,
    );
    act(() => { vi.runAllTimers(); });
    const input = screen.getByRole("textbox", { name: "Question" });
    input.focus();
    rerender(<Modal open onClose={nextClose} title="Review request"><textarea aria-label="Question" /></Modal>);
    act(() => { vi.runAllTimers(); });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(previousClose).not.toHaveBeenCalled();
    expect(nextClose).toHaveBeenCalledOnce();
  });

  it("restores scrolling when navigation unmounts both dialogs together", () => {
    vi.useFakeTimers();
    document.body.style.overflow = "auto";
    openReview();
    cleanup();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("supports locks released out of order, including repeated releases", () => {
    document.body.style.overflow = "scroll";
    const releaseParent = lockBodyScroll();
    const releaseReview = lockBodyScroll();
    releaseParent();
    releaseParent();
    expect(document.body.style.overflow).toBe("hidden");
    releaseReview();
    releaseReview();
    expect(document.body.style.overflow).toBe("scroll");
  });
});

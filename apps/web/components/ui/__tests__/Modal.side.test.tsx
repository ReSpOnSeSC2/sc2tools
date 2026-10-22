import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Modal } from "../Modal";

afterEach(cleanup);

function scrimOf(dialog: HTMLElement): HTMLElement {
  return dialog.parentElement as HTMLElement;
}

describe("Modal desktopLayout=side", () => {
  it("docks a full-height panel to the right on desktop and stays a bottom sheet on mobile", () => {
    render(
      <Modal open onClose={() => {}} title="Help" desktopLayout="side">
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Help" });
    const scrim = scrimOf(dialog);
    expect(scrim.className).toContain("sm:justify-end");
    expect(scrim.className).toContain("sm:items-stretch");
    expect(scrim.className).toContain("items-end");
    expect(scrim.className).not.toContain("sm:items-center");
    expect(dialog.className).toContain("sm:h-[100dvh]");
    expect(dialog.className).toContain("sm:rounded-none");
    expect(dialog.className).toContain("rounded-t-2xl");
    expect(dialog.className).not.toContain("sm:max-h-[85vh]");
  });

  it("keeps the centered card by default", () => {
    render(
      <Modal open onClose={() => {}} title="Plain">
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Plain" });
    expect(scrimOf(dialog).className).toContain("sm:items-center sm:p-4");
    expect(dialog.className).toContain("sm:max-h-[85vh]");
    expect(dialog.className).toContain("sm:rounded-xl");
  });
});

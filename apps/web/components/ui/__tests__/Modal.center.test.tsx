import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Modal } from "../Modal";

describe("Modal mobileLayout=center", () => {
  afterEach(() => cleanup());

  it("applies items-center and rounded-2xl when centered on mobile", () => {
    render(
      <Modal open onClose={() => {}} title="T" description="D" mobileLayout="center">
        <p data-testid="body">hi</p>
      </Modal>,
    );
    const body = screen.getByTestId("body");
    // walk up to find scrim
    let scrim: HTMLElement | null = body.parentElement;
    while (scrim && !scrim.className.includes("z-50")) {
      scrim = scrim.parentElement;
    }
    expect(scrim).not.toBeNull();
    expect(scrim!.className).toContain("items-center");
    expect(scrim!.className).not.toContain("items-end");

    const dialog = scrim!.querySelector("[role='dialog']") as HTMLElement;
    expect(dialog.className).toContain("rounded-2xl");
    expect(dialog.className).not.toContain("rounded-t-2xl");
  });

  it("renders title, description, and all children when centered on mobile", () => {
    render(
      <Modal open onClose={() => {}} title="My Title" description="My Desc" mobileLayout="center">
        <p>Item 1</p>
        <p>Item 2</p>
        <p>Item 3</p>
        <p>Item 4</p>
        <p>Item 5</p>
        <p>Item 6</p>
      </Modal>,
    );
    expect(screen.getByText("My Title")).toBeTruthy();
    expect(screen.getByText("My Desc")).toBeTruthy();
    for (let i = 1; i <= 6; i++) {
      expect(screen.getByText(`Item ${i}`)).toBeTruthy();
    }
  });

  it("guards against horizontal overflow with min-w-0 on the dialog", () => {
    render(
      <Modal open onClose={() => {}} title="T" mobileLayout="center">
        <p data-testid="body">hi</p>
      </Modal>,
    );
    const body = screen.getByTestId("body");
    let scrim: HTMLElement | null = body.parentElement;
    while (scrim && !scrim.className.includes("z-50")) {
      scrim = scrim.parentElement;
    }
    const dialog = scrim!.querySelector("[role='dialog']") as HTMLElement;
    expect(dialog.className).toContain("min-w-0");
  });

  it("falls back to bottom sheet when mobileLayout is not center", () => {
    render(
      <Modal open onClose={() => {}} title="T">
        <p data-testid="body">hi</p>
      </Modal>,
    );
    const body = screen.getByTestId("body");
    let scrim: HTMLElement | null = body.parentElement;
    while (scrim && !scrim.className.includes("z-50")) {
      scrim = scrim.parentElement;
    }
    expect(scrim!.className).toContain("items-end");
    expect(scrim!.className).not.toContain("items-center p-4");
  });
});

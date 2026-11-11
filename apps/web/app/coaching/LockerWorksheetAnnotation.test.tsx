import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LockerWorksheetAnnotation } from "./LockerWorksheetAnnotation";

const FLAT = "data:image/jpeg;base64,QUJD";

class FixtureImage {
  naturalWidth = 640;
  naturalHeight = 320;
  onload: (() => void) | null = null;
  set src(_value: string) { queueMicrotask(() => this.onload?.()); }
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("marks a screenshot with the keyboard, undoes it, and saves a flat raster", async () => {
  vi.stubGlobal("Image", FixtureImage);
  const draw = { clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), ellipse: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), arc: vi.fn(), stroke: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(draw as unknown as CanvasRenderingContext2D);
  const flatten = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(FLAT);
  const save = vi.fn();
  render(<LockerWorksheetAnnotation existing={FLAT} onSave={save} onCancel={() => {}} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Save annotation" }) as HTMLButtonElement).disabled).toBe(false));
  const canvas = screen.getByLabelText("Screenshot annotation canvas");
  fireEvent.keyDown(canvas, { key: " " });
  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  fireEvent.keyDown(canvas, { key: " " });
  expect(draw.ellipse).toHaveBeenLastCalledWith(326, 160, 12, 6, 0, 0, 2 * Math.PI);
  fireEvent.click(screen.getByRole("button", { name: "Undo mark" }));
  expect((screen.getByRole("button", { name: "Undo mark" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
  expect(flatten).toHaveBeenCalledWith("image/jpeg", 0.85);
  expect(save).toHaveBeenCalledWith(FLAT);
});

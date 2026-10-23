import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuideSectionCopy } from "../GuideSectionCopy";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("GuideSectionCopy", () => {
  it("copies the canonical section URL without filters and announces success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    window.history.replaceState(null, "", "/guides/pvz/opener?band=league:4#old");
    render(<GuideSectionCopy id="key-timings" label="Key timings" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link to Key timings" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Link copied"));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/guides/pvz/opener#key-timings`);
  });
  it("selects a read-only link for manual copying when clipboard access fails", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) } });
    render(<GuideSectionCopy id="army" label="Army" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy link to Army" }));
    const input = await screen.findByRole("textbox", { name: "Copy this section link" }) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(input.value).toMatch(/#army$/);
  });
});

// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesignGallery } from "./DesignGallery";

vi.mock("next/image", () => ({ default: ({ alt }: React.ImgHTMLAttributes<HTMLImageElement>) => <span aria-label={alt} /> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/design" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "admin-fixture" }) }));

afterEach(() => { cleanup(); document.body.style.overflow = ""; document.documentElement.dataset.theme = "dark"; localStorage.clear(); });

describe("design gallery examples", () => {
  it("labels synthetic values and exposes every example group", () => {
    render(<DesignGallery />);
    expect(screen.getByRole("heading", { name: "Design gallery", level: 1 })).toBeTruthy();
    expect(screen.getByText(/All values are examples/)).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Gallery examples" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Controls", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Dialogs and overlays", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Content and states", level: 2 })).toBeTruthy();
    expect(screen.getByLabelText("Invalid example").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Disabled example").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Loading example" }).getAttribute("aria-busy")).toBe("true");
  });

  it("lets the shared theme control preview both palettes", () => {
    render(<DesignGallery />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it.each([ ["Open Modal", "Modal example"], ["Open bottom Sheet", "Bottom Sheet example"], ["Open right Sheet", "Right Sheet example"] ])("wires %s to its real dismissible overlay", async (label, title) => {
    render(<DesignGallery />);
    const trigger = screen.getByRole("button", { name: label });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: title });
    expect(within(dialog).getByLabelText("Example dialog input")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: title })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("uses nonmodal Popover and returns its trigger state on close", async () => {
    render(<DesignGallery />);
    const trigger = screen.getByRole("button", { name: "Open Popover" });
    trigger.focus(); fireEvent.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "Popover example" });
    expect(popover.hasAttribute("aria-modal")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(popover).getByRole("button", { name: "Close Popover" }));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps both confirmation examples local", async () => {
    render(<DesignGallery />);
    fireEvent.click(screen.getByRole("button", { name: "Open ConfirmDialog" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Confirm an example?" })).getByRole("button", { name: "Accept example" }));
    expect(screen.getByText("Example confirmation accepted. No data was changed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try useConfirm" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Confirm this example?" })).getByRole("button", { name: "Cancel" }));
    await screen.findByText("Promise example canceled.");
  });

  it("cycles honest query states and Retry only changes the local preview", async () => {
    render(<DesignGallery />);
    const choice = screen.getByLabelText("Query example state");
    fireEvent.change(choice, { target: { value: "empty" } });
    expect(screen.getByText("No example results")).toBeTruthy();
    fireEvent.change(choice, { target: { value: "error" } });
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry|Try again/ }));
    await screen.findByText("Example replay · Ready preview");
    fireEvent.change(choice, { target: { value: "previous" } });
    expect(screen.getByText(/Showing the previous example while updating/)).toBeTruthy();
  });

  it("shows SaveBar only for a local dirty draft", () => {
    render(<DesignGallery />);
    expect(screen.queryByRole("button", { name: "Save example" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Local draft example"), { target: { value: "Edited example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save example" }));
    expect(screen.queryByRole("button", { name: "Save example" })).toBeNull();
    expect(screen.getByText("Example saved locally in this preview.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Local draft example"), { target: { value: "Discarded draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset example" }));
    expect((screen.getByLabelText("Local draft example") as HTMLInputElement).value).toBe("Edited example");
  });
});

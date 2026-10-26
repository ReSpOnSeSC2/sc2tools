import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { CrashCourse } from "./CrashCourse";

const STORAGE_KEY = "sc2tools:stream-studio:crash-course:v1";

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Stream Studio crash course", () => {
  it("navigates between lessons and reveals the current lesson's practical check", () => {
    render(<CrashCourse />);

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Connect the dots");
    expect(screen.getByRole("button", { name: "Previous lesson" }).getAttribute("disabled")).not.toBeNull();
    const firstLesson = screen.getByRole("button", { name: /1\. Connect the dots/ });
    expect(firstLesson.getAttribute("aria-pressed")).toBe("true");
    const reveal = screen.getByRole("button", { name: "What should you see?" });
    expect(reveal.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(reveal);
    expect(screen.getByText(/The agent collects game information/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next lesson" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Pair your gaming PC");
    expect(firstLesson.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "What should you see?" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/The agent collects game information/)).toBeNull();
    expect(screen.getByRole("link", { name: "Open Devices" }).getAttribute("href")).toBe("/devices");

    fireEvent.click(screen.getByRole("button", { name: /5\. Add your next feature/ }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Add your next feature");
    expect(screen.getByRole("link", { name: "Choose randomizer builds" }).getAttribute("href")).toBe("/settings?tab=randomizer");
    expect(screen.getByRole("link", { name: "Set up voice" }).getAttribute("href")).toBe("/settings?tab=voice");
    fireEvent.click(screen.getByRole("button", { name: /6\. Add a stats panel/ }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Add a stats panel to your channel");
    expect(screen.getByRole("link", { name: "Choose public profile and panel" }).getAttribute("href")).toBe("/settings?tab=profile");
    expect(screen.queryByRole("button", { name: "Next lesson" })).toBeNull();
  });

  it("saves the checklist and current lesson, resumes after remount and resets both", async () => {
    const first = render(<CrashCourse />);
    fireEvent.click(screen.getByRole("checkbox", { name: "I tried this lesson and checked the result" }));
    fireEvent.click(screen.getByRole("button", { name: /3\. Build your first scene/ }));

    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      activeId: "build-your-scene",
      completed: ["connect-the-dots"],
    }));
    first.unmount();
    render(<CrashCourse />);

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Build your first scene");
    expect(screen.getByText(/of 6 lessons complete/).textContent).toBe("1 of 6 lessons complete.");
    expect(screen.getByRole("button", { name: /1\. Connect the dots/ }).textContent).toContain("Complete");
    fireEvent.click(screen.getByRole("button", { name: /1\. Connect the dots/ }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Reset course progress" }));
    expect(screen.getByText(/of 6 lessons complete/).textContent).toBe("0 of 6 lessons complete.");
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Connect the dots");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({ activeId: "connect-the-dots", completed: [] }));
  });

  it("restores only known lessons and does not replace saved progress with a mount fallback", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      activeId: "test-with-purpose",
      completed: ["pair-your-pc", "pair-your-pc", "removed-lesson", 4],
    }));
    const write = vi.spyOn(Storage.prototype, "setItem");
    render(<CrashCourse />);

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Test, then play");
    expect(screen.getByText(/of 6 lessons complete/).textContent).toBe("1 of 6 lessons complete.");
    expect(write).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify({ activeId: "test-with-purpose", completed: ["pair-your-pc"] }));
    expect(write).not.toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify({ activeId: "connect-the-dots", completed: [] }));
  });

  it("uses a stable server render without reading browser storage", () => {
    const read = vi.spyOn(Storage.prototype, "getItem");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeId: "make-it-yours", completed: ["connect-the-dots"] }));

    const markup = renderToString(<CrashCourse />);

    expect(read).not.toHaveBeenCalled();
    expect(markup).toContain("Connect the dots");
    expect(markup).not.toContain("Set up chat and the Stream Dock");
  });

  it("keeps navigation and completion usable when storage reads or writes are blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    render(<CrashCourse />);

    expect(screen.getByText(/Browser storage is unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/of 6 lessons complete/).textContent).toBe("1 of 6 lessons complete.");
    fireEvent.click(screen.getByRole("button", { name: "Next lesson" }));
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Pair your gaming PC");
    fireEvent.click(screen.getByRole("button", { name: "Previous lesson" }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reset course progress" }));
    expect(screen.getByText(/of 6 lessons complete/).textContent).toBe("0 of 6 lessons complete.");
  });

  it("recovers from malformed saved data and allows a completed lesson to be unchecked", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not-json");
    render(<CrashCourse />);

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Connect the dots");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/of 6 lessons complete/).textContent).toBe("0 of 6 lessons complete.");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({ activeId: "connect-the-dots", completed: [] });
  });
});

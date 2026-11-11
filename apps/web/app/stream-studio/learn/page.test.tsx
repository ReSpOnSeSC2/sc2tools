import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import StreamStudioLearnRoute, { metadata } from "./page";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Stream Studio learning hub", () => {
  it("has a public canonical page and links to the course, widget library and actual setup", async () => {
    expect(metadata.alternates?.canonical).toBe("/stream-studio/learn");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<StreamStudioLearnRoute />);
    await act(async () => {});
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Start the crash course" }).getAttribute("href")).toBe("#crash-course");
    expect(screen.getByRole("navigation", { name: "Learning sections" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Overlay settings" }).getAttribute("href")).toBe("/settings?tab=overlay");
    expect(screen.getByRole("heading", { name: "Start with what you can see." })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Your setup" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

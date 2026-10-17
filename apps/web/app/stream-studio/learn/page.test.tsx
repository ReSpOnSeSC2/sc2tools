import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import StreamStudioLearnRoute, { metadata } from "./page";

afterEach(cleanup);

describe("Stream Studio learning hub", () => {
  it("has a public canonical page and links to the course, widget library and actual setup", () => {
    expect(metadata.alternates?.canonical).toBe("/stream-studio/learn");
    render(<StreamStudioLearnRoute />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Start the crash course" }).getAttribute("href")).toBe("#crash-course");
    expect(screen.getByRole("navigation", { name: "Learning sections" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Overlay settings" }).getAttribute("href")).toBe("/settings?tab=overlay");
    expect(screen.getByRole("heading", { name: "Start with what you can see." })).toBeTruthy();
  });
});

/**
 * NoGamesYet — the agent-only empty state by default, and two paths
 * (desktop agent / browser import) when browser import is enabled.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoGamesYet } from "../EmptyStates";

afterEach(cleanup);

describe("NoGamesYet", () => {
  it("keeps the agent-only copy when browser import is off", () => {
    render(<NoGamesYet />);
    expect(screen.getByRole("link", { name: /download agent/i }).getAttribute("href")).toBe("/download");
    expect(screen.getByRole("link", { name: /open devices/i }).getAttribute("href")).toBe("/devices");
    expect(screen.queryByRole("link", { name: /import in your browser/i })).toBeNull();
  });

  it("offers the agent and browser import side by side when enabled", () => {
    render(<NoGamesYet browserImportEnabled />);
    expect(screen.getByRole("link", { name: "Install the desktop agent" }).getAttribute("href")).toBe("/download");
    expect(screen.getByRole("link", { name: "Import in your browser — no download" }).getAttribute("href")).toBe(
      "/settings?tab=import",
    );
    const list = screen.getByRole("list");
    expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(["grid-cols-1", "sm:grid-cols-2"]));
    expect(screen.getByTestId("dashboard-no-games")).toBeTruthy();
  });
});

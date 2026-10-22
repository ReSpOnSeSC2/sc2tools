import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EmptyState } from "../Card";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));

afterEach(cleanup);

describe("Card EmptyState", () => {
  it("renders the shared empty-state panel with title and sub-line", () => {
    render(<EmptyState title="No maps yet" sub="Play a few games first." />);
    expect(screen.getByText("No maps yet")).toBeTruthy();
    expect(screen.getByText("Play a few games first.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("adds a Learn how link to the help article that opens in place", async () => {
    render(<EmptyState title="No builds yet" helpSlug="build-check-in" />);
    const link = await screen.findByRole("link", { name: "Learn how" });
    expect(link.getAttribute("href")).toBe("/help/build-check-in");
    // Once the help chunk has loaded the link opens the side sheet.
    await vi.waitFor(() =>
      expect(screen.getByRole("link", { name: "Learn how" }).getAttribute("aria-haspopup")).toBe("dialog"),
    );
    fireEvent.click(screen.getByRole("link", { name: "Learn how" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("puts a caller's action next to the help link", () => {
    render(<EmptyState title="Nothing yet" action={<button type="button">Import</button>} />);
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
  });
});

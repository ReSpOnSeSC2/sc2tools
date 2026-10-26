import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AuthorChip } from "../AuthorChip";
afterEach(cleanup);
it("keeps a published author name plain without a profile capability", () => {
  render(<AuthorChip build={{ authorName: "Public author", ownerUserId: "private-owner" }} />);
  expect(screen.getByText("Public author")).toBeTruthy(); expect(screen.queryByRole("link")).toBeNull();
});
it("uses only a canonical capability for its player link", () => {
  render(<AuthorChip build={{ authorName: "Public author", authorProfileHandle: "frontier-0123456789" }} />);
  expect(screen.getByRole("link", { name: "Public author" }).getAttribute("href")).toBe("/players/frontier-0123456789");
});
it("does not link anonymous or malformed capabilities", () => {
  const view = render(<AuthorChip build={{ authorProfileHandle: "frontier-0123456789" }} />);
  expect(screen.getByText("Anonymous")).toBeTruthy(); expect(screen.queryByRole("link")).toBeNull();
  view.rerender(<AuthorChip build={{ authorName: "Declared name", authorProfileHandle: "owner-uuid" }} />);
  expect(screen.getByText("Declared name")).toBeTruthy(); expect(screen.queryByRole("link")).toBeNull();
});

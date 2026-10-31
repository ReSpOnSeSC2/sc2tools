/**
 * Test helper: load LazyHelpLink's HelpLink chunk before rendering a page that shows several of them at once.
 *
 * React 19.0 retries each suspended boundary on one of four rotating retry lanes. Settings > Backups & data suspends
 * four boundaries on the first render (three help links and the HiddenGames chunk), so the retries keep landing on
 * lanes that are still pending and React never marks them suspended. Inside a synchronous render() the chunk cannot
 * finish loading, so act() re-renders forever. In a browser the loop ends when the chunk arrives. Once loaded, the
 * links render without suspending.
 *
 * Example:
 *   beforeAll(loadLazyHelpLink, 20_000);
 */
import { render, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { LazyHelpLink } from "../LazyHelpLink";

export async function loadLazyHelpLink(): Promise<void> {
  const view = render(<LazyHelpLink slug="backups-and-export">Loading help</LazyHelpLink>);
  try {
    // The loaded HelpLink opens a sheet; the fallback is a plain link.
    await waitFor(
      () => expect(view.getByRole("link", { name: "Loading help" }).getAttribute("aria-haspopup")).toBe("dialog"),
      { timeout: 15_000 },
    );
  } finally {
    view.unmount();
  }
}

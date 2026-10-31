/**
 * Test helper: load LazyHelpLink's HelpLink chunk before rendering a page that shows several of them at once.
 *
 * Tests run react-dom 19.0.0, which retries each suspended boundary on one of four rotating retry lanes. Settings >
 * Backups & data suspends several help links around its first render, so the retries keep landing on lanes that are
 * still pending and are never marked suspended. Inside a synchronous render() the chunk cannot finish loading, so act()
 * re-renders forever. Production runs Next's own React build (a 19.2 canary); measured outside act() while a lazy chunk
 * loaded, it committed three to five times in 1.6 seconds and did not cycle. Once loaded, the links render without
 * suspending.
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

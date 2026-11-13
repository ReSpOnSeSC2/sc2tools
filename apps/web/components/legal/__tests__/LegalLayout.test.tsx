import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PrivacyPage from "@/app/legal/privacy/page";
afterEach(cleanup);
it("provides a table of contents that points to every real policy section", () => {
  const { container } = render(<PrivacyPage />);
  const updated = screen.getByText("November 13, 2026", { selector: "time" });
  expect(updated.getAttribute("datetime")).toBe("2026-11-13");

  const sectionHashes = Array.from(container.querySelectorAll("[data-legal] h2[id]"), (heading) => `#${heading.id}`);
  const tablesOfContents = container.querySelectorAll("[data-legal-toc] nav");
  expect(tablesOfContents).toHaveLength(2);
  for (const tableOfContents of tablesOfContents) {
    const linkHashes = Array.from(tableOfContents.querySelectorAll("a"), (link) => link.hash);
    expect(linkHashes).toEqual(sectionHashes);
  }
  expect(container.querySelector(".prose")).toBeNull();
  expect(screen.getByRole("heading", { name: /The short version/ })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Backups", level: 2 }).id).toBe("backups");
  expect(screen.getByRole("link", { name: "Link to section: Backups" }).getAttribute("href")).toBe("#backups");
  expect(screen.getByRole("button", { name: "Cookie settings" })).toBeTruthy();
});

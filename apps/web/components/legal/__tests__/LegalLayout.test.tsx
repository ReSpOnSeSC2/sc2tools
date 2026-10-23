import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PrivacyPage from "@/app/legal/privacy/page";
afterEach(cleanup);
it("provides a table of contents that points to every real policy section", () => {
  const { container } = render(<PrivacyPage />);
  expect(screen.getByText("October 23, 2026")).toBeTruthy();
  for (const link of Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-legal-toc] a'))) {
    expect(container.querySelector(link.hash)?.tagName).toBe("H2");
  }
  expect(container.querySelector(".prose")).toBeNull();
  expect(screen.getByRole("heading", { name: /The short version/ })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Backups", level: 2 }).id).toBe("backups");
  expect(screen.getByRole("link", { name: "Link to section: Backups" }).getAttribute("href")).toBe("#backups");
  expect(screen.getByRole("button", { name: "Cookie settings" })).toBeTruthy();
});

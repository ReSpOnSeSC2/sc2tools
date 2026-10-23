import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CopyPaypalEmail } from "./CopyPaypalEmail";
import { CostBar, costBarSegments } from "./CostBar";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("copies the public email and reports Email copied", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<CopyPaypalEmail email="public@example.com" />); fireEvent.click(screen.getByRole("button", { name: "Copy PayPal email" }));
  await screen.findByRole("status"); expect(writeText).toHaveBeenCalledWith("public@example.com"); expect(screen.getByText("Email copied")).toBeTruthy();
});
it("selects the email when clipboard access fails", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  render(<CopyPaypalEmail email="public@example.com" />); fireEvent.click(screen.getByRole("button", { name: "Copy PayPal email" }));
  await waitFor(() => expect(window.getSelection()?.toString()).toBe("public@example.com"));
  expect(screen.getByRole("status").textContent).toContain("email selected");
});
it("groups provider lines, omits zero costs and uses token colors", () => {
  const lines = [{ id: "render", approxMonthlyUsd: 4 }, { id: "render", approxMonthlyUsd: 3 }, { id: "mongo", approxMonthlyUsd: 56.94 }, { id: "r2", approxMonthlyUsd: 0 }];
  expect(costBarSegments(lines).map((s) => [s.label, s.usd])).toEqual([["Render", 7], ["Atlas", 56.94]]);
  const { container } = render(<CostBar lines={lines} />);
  expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Total $63.94");
  expect(container.querySelector('[data-provider="r2"]')).toBeNull();
  for (const segment of container.querySelectorAll<HTMLElement>("[data-provider]")) expect(segment.style.backgroundColor).toContain("var(--");
});

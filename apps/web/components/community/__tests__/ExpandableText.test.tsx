import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ExpandableText } from "../ExpandableText";

afterEach(cleanup);

it("keeps the premeasurement fallback but removes the toggle when the text fits", () => {
  const { container } = render(<ExpandableText text={"Long text ".repeat(50)} />);
  expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
  const paragraph = container.querySelector("p")!;
  Object.defineProperties(paragraph, { clientHeight: { value: 120, configurable: true }, scrollHeight: { value: 120, configurable: true } });
  fireEvent(window, new Event("resize"));
  expect(screen.queryByRole("button")).toBeNull();
});

it("measures actual overflow for short text and preserves the disclosure while expanded", () => {
  const { container } = render(<ExpandableText text={"A long unbroken word that wraps at a narrow width"} />);
  expect(screen.queryByRole("button")).toBeNull();
  const paragraph = container.querySelector("p")!;
  Object.defineProperties(paragraph, { clientHeight: { value: 120 }, scrollHeight: { value: 240 } });
  fireEvent(window, new Event("resize"));
  const more = screen.getByRole("button", { name: "Show more" });
  expect(more.getAttribute("aria-controls")).toBe(paragraph.id);
  fireEvent.click(more); expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  expect(paragraph.className).not.toContain("line-clamp-6");
  fireEvent.click(screen.getByRole("button", { name: "Show less" })); expect(paragraph.className).toContain("line-clamp-6");
});

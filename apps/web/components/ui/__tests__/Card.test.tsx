import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Card } from "../Card";

afterEach(cleanup);

describe("Card headingLevel", () => {
  it("renders the legacy title as an h3 by default", () => {
    render(<Card title="Recent games">body</Card>);
    expect(screen.getByRole("heading", { level: 3, name: "Recent games" })).toBeTruthy();
  });

  it("uses the level asked for, with the same look", () => {
    render(
      <>
        <Card title="Under the page title" headingLevel={2}>a</Card>
        <Card title="Nested" headingLevel={4}>b</Card>
      </>,
    );
    const h2 = screen.getByRole("heading", { level: 2, name: "Under the page title" });
    const h4 = screen.getByRole("heading", { level: 4, name: "Nested" });
    expect(h2.className).toBe(h4.className);
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("renders no heading without a title", () => {
    render(<Card right={<button type="button">Edit</button>}>body</Card>);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

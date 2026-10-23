import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "../Button";
import { buttonClassName } from "../buttonStyles";

afterEach(cleanup);

describe("buttonClassName", () => {
  it("gives a link exactly the pill a Button wears", () => {
    render(
      <Button variant="secondary" size="sm" className="extra">
        Pill
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Pill" }).className).toBe(
      buttonClassName({ variant: "secondary", size: "sm", className: "extra" }),
    );
  });

  it("defaults to the primary, medium pill", () => {
    const classes = buttonClassName();
    expect(classes).toContain("bg-accent");
    expect(classes).toContain("h-11");
    expect(classes).toContain("rounded-full");
    expect(classes).toContain("focus-visible:ring-2");
    expect(buttonClassName({ fullWidth: true })).toContain("w-full");
  });
});

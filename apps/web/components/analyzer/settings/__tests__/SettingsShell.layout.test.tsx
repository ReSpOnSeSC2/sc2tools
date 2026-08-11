import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SettingsShell } from "../SettingsShell";

afterEach(cleanup);

describe("SettingsShell layout containment", () => {
  it("gives the content track a zero minimum width", () => {
    const { container } = render(
      <SettingsShell
        initialTab="overlay"
        renderTab={(id) => <div>{id}</div>}
      />,
    );

    const grid = container.firstElementChild;
    expect(grid).not.toBeNull();
    expect(grid!.className.split(/\s+/)).toContain(
      "lg:grid-cols-[240px_minmax(0,1fr)]",
    );

    const panel = screen.getByRole("tabpanel", { name: "Overlay" });
    expect(panel.className.split(/\s+/)).toContain("min-w-0");
    expect(
      screen.getAllByRole("tab", { name: "Backups & data" }),
    ).toHaveLength(2);
  });
});

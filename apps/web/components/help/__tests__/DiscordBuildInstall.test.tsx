import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiscordBuildInstall } from "../DiscordBuildInstall";

describe("Add to Discord", () => {
  it("shows status without an install link until the owner publishes the ID", () => {
    const view = render(<DiscordBuildInstall />);
    expect(screen.getByText("Discord installation is currently unavailable.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Add to Discord" })).toBeNull();
    view.rerender(<DiscordBuildInstall applicationId="123456789012345678" />);
    expect(screen.getByRole("link", { name: "Add to Discord" })).toHaveAttribute(
      "href", "https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=applications.commands&integration_type=0",
    );
  });
});

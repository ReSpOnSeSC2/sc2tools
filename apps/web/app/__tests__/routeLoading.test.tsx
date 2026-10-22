import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import BuildsLoading from "../builds/loading";
import CommunityLoading from "../community/loading";
import DevicesLoading from "../devices/loading";
import SettingsLoading from "../settings/loading";

afterEach(cleanup);

describe("route loading skeletons", () => {
  it.each<[string, ComponentType, string]>([
    ["/builds", BuildsLoading, "Loading your build library"],
    ["/community", CommunityLoading, "Loading community builds"],
    ["/devices", DevicesLoading, "Loading devices"],
    ["/settings", SettingsLoading, "Loading settings"],
  ])("%s announces one loading message instead of plain text", (_route, Loading, label) => {
    render(<Loading />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toBe(label);
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ isLoaded: true, isSignedIn: false }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
import { BuildVariantContinuation } from "./BuildVariantContinuation";
beforeEach(() => { auth.isLoaded = true; auth.isSignedIn = false; }); afterEach(cleanup);
describe("explicit variant continuation", () => {
  it("signs in through a public catalog URL without private filters", () => {
    render(<BuildVariantContinuation id="zerg-12-pool" name="Zerg - 12 Pool" />);
    expect(new URL(screen.getByRole("link").getAttribute("href")!, "https://local.test").searchParams.get("redirect_url")).toBe("/definitions?variant=zerg-12-pool");
  });
  it("requires an explicit signed-in action before opening a private draft", () => {
    auth.isSignedIn = true; render(<BuildVariantContinuation id="zerg-12-pool" name="Zerg - 12 Pool" />);
    expect(screen.getByRole("link", { name: "Continue private variant" }).getAttribute("href")).toBe("/builds?create=detected&definition=zerg-12-pool");
  });
  it("waits for auth and refuses unknown ids", () => {
    auth.isLoaded = false; const view = render(<BuildVariantContinuation id="zerg-12-pool" name="Zerg - 12 Pool" />);
    expect(screen.getByRole("status").textContent).toContain("Checking"); expect(screen.queryByRole("link")).toBeNull();
    view.rerender(<BuildVariantContinuation id="unknown" name="Unknown" />); expect(screen.queryByRole("region")).toBeNull();
  });
});

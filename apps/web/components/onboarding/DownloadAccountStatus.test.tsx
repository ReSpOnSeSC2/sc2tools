import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResyncNotice, InstalledAgentVersion } from "./DownloadAccountStatus";
const fixture = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: true }, me: { agentPaired: true, agentVersion: "0.18.2" }, warnings: [] as { id: string }[] }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => fixture.auth }));
vi.mock("@/lib/clientApi", () => ({ useApi: (path: string | null) => ({ data: path === "/v1/me" ? fixture.me : path ? { warnings: fixture.warnings } : undefined }) }));
vi.mock("./useReleaseInfo", () => ({ useReleaseInfo: () => ({ data: { latest: "0.19.0" } }) }));
beforeEach(() => { fixture.auth = { isLoaded: true, isSignedIn: true }; fixture.me = { agentPaired: true, agentVersion: "0.18.2" }; fixture.warnings = []; });
afterEach(cleanup);
it("hides migration guidance for signed-out, first-time and unaffected visitors", () => {
  fixture.auth.isSignedIn = false; fixture.warnings = [{ id: "replay_archive_incomplete" }];
  const view = render(<><ResyncNotice /><InstalledAgentVersion /></>); expect(screen.queryByRole("note")).toBeNull(); expect(document.body.textContent).toBe("");
  fixture.auth.isSignedIn = true; fixture.warnings = []; view.rerender(<ResyncNotice />); expect(screen.queryByRole("note")).toBeNull();
  fixture.warnings = [{ id: "no_games" }]; view.rerender(<ResyncNotice />); expect(screen.queryByRole("note")).toBeNull();
});
it("shows migration guidance only for the archive warning", () => {
  fixture.warnings = [{ id: "replay_archive_incomplete" }]; render(<ResyncNotice />);
  expect(screen.getByRole("note").textContent).toContain("Re-sync replay library");
});
it.each([["0.18.2", "Your PC runs v0.18.2. Update available: v0.19.0"], ["0.19.0", "You're up to date (v0.19.0)"], ["0.20.0", "You're up to date (v0.20.0)"]])("shows accurate status for %s", (version, copy) => {
  fixture.me.agentVersion = version; render(<InstalledAgentVersion />); expect(screen.getByText(copy)).toBeTruthy();
});
it("hides version status without a paired agent or a valid reported version", () => {
  fixture.me.agentPaired = false; const view = render(<InstalledAgentVersion />); expect(document.body.textContent).toBe("");
  fixture.me.agentPaired = true; fixture.me.agentVersion = "unknown"; view.rerender(<InstalledAgentVersion />); expect(document.body.textContent).toBe("");
});

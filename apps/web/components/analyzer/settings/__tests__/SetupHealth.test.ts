import { describe, expect, it, vi } from "vitest";
import { setupAgentOnline, setupHealthRows, type SetupMe } from "../setupHealth";
import { setupDiagnostics } from "../SetupDiagnostics";

const now = Date.parse("2026-10-23T12:00:00Z");
const me: SetupMe = { userId: "cloud-user", agentPaired: true, agentVersion: "0.20.0", agentLastSeenAt: new Date(now - 1000).toISOString(), games: { total: 12, latest: new Date(now - 1000).toISOString() }, onboarding: { goals: ["stream"] } };
function sources() { return { me: { data: me, mutate: vi.fn() }, doctor: { data: { ok: true, warnings: [] as { id: string; severity: "warn"; message: string; cta?: { label: string; href: string } }[] }, mutate: vi.fn() }, release: { data: { latest: "0.20.0" }, mutate: vi.fn() }, overlays: { data: { items: [{ lastSeenAt: new Date(now - 1000).toISOString() }] }, mutate: vi.fn() }, now }; }

describe("setup health from independent sources", () => {
  it("reports a complete setup and uses the shared heartbeat window", () => {
    expect(setupHealthRows(sources()).every((row) => row.tone === "pass")).toBe(true);
    expect(setupAgentOnline({ ...me, agentLastSeenAt: new Date(now - 180001).toISOString() }, now)).toBe(false);
    expect(setupAgentOnline({ ...me, agentLastSeenAt: new Date(now + 60000).toISOString() }, now)).toBe(false);
  });
  it("shows offline, outdated and missing game attention without hiding the other checks", () => {
    const input = sources(); input.me.data = { ...me, agentLastSeenAt: new Date(now - 86400000).toISOString(), agentVersion: "0.19.0", games: { total: 0 } };
    const rows = setupHealthRows(input);
    expect(rows.find((row) => row.id === "desktop")?.message).toContain("open SC2 Tools on your PC");
    expect(rows.find((row) => row.id === "version")?.message).toContain("Update available → v0.20.0");
    expect(rows.find((row) => row.id === "games")?.cta?.href).toBe("/settings?tab=import");
    expect(rows.find((row) => row.id === "identity")?.tone).toBe("pass");
  });
  it("shows identity/archive warnings and every future doctor warning with its own action", () => {
    const input = sources(); input.doctor.data.warnings = [
      { id: "no_profile", severity: "warn", message: "Missing profile" },
      { id: "replay_archive_incomplete", severity: "warn", message: "Re-sync your files", cta: { label: "Re-sync", href: "/download" } },
      { id: "future_check", severity: "warn", message: "Future issue", cta: { label: "Repair", href: "/settings" } },
    ];
    const rows = setupHealthRows(input);
    expect(rows.find((row) => row.id === "identity")?.cta?.href).toBe("/settings?tab=profile");
    expect(rows.find((row) => row.id === "archive")?.message).toBe("Re-sync your files");
    expect(rows.find((row) => row.id === "future_check")?.cta?.label).toBe("Repair");
  });
  it("contains failures to their sources and treats optional streaming honestly", () => {
    const input = sources();
    const rows = setupHealthRows({ ...input, release: { ...input.release, error: new Error("offline") } });
    expect(rows.find((row) => row.id === "version")?.message).toBe("Couldn't check for updates");
    expect(rows.filter((row) => row.tone === "warn")).toHaveLength(1);
    input.overlays.data.items = [];
    expect(setupHealthRows(input).find((row) => row.id === "overlay")?.tone).toBe("info");
    input.me.data = { ...me, onboarding: { goals: ["improve"] } };
    expect(setupHealthRows(input).some((row) => row.id === "overlay")).toBe(false);
  });
  it("copies allowlisted diagnostics without email, overlay credentials or token URLs", () => {
    const sensitive = { ...me, email: "private@example.com", overlayToken: "secret-overlay", url: "/overlay/secret-overlay?token=private" };
    const text = setupDiagnostics(sensitive, ["no_games"], { userAgent: "Mozilla/5.0 Windows Chrome/129.0", width: 390, height: 844, now });
    expect(text).toContain("User ID: cloud-user"); expect(text).toContain("Games: 12"); expect(text).toContain("no_games");
    expect(text).not.toMatch(/private@example|secret-overlay|token=/);
  });
});

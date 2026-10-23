import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PrivacyPage from "../page";

afterEach(cleanup);

describe("privacy policy backups", () => {
  it("explains configured service backups, private snapshot retention and export", () => {
    render(<PrivacyPage />);

    const heading = screen.getByRole("heading", { name: "Backups" });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    const text = section!.textContent || "";
    expect(text).toMatch(/MongoDB Atlas keeps whole-database snapshots under our configured backup schedule/);
    expect(text).toMatch(/Current database backup retention window is unavailable/);
    expect(text).toMatch(/not a\s+way to restore one account on request/);
    expect(text).toMatch(/5 manual snapshots,\s+2 weekly automatic snapshots, and 3 snapshots/);
    expect(text).toMatch(/private Cloudflare R2 storage/);
    expect(text).toMatch(/All private snapshots are removed when you delete your account/);
    expect(text).toMatch(/Copies already inside database backups are not edited/);
    expect(section!.querySelector('a[href="/settings?tab=backups"]')).not.toBeNull();
  });

  it("points the deletion promise at the backup expiry", () => {
    render(<PrivacyPage />);
    const rights = screen.getByRole("heading", { name: "Your rights" }).closest("section");
    expect(rights?.textContent).toMatch(/Copies already inside database backups are not edited individually/);
    expect(rights?.textContent).toMatch(/\[deleted user\]/);
    expect(rights?.textContent).toMatch(/keyed guard for 30 days/);
    expect(rights?.textContent).toMatch(/private support message text and replies are removed/);
  });
});

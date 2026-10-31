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

  it("discloses the game history Daily Pulse can keep in this browser, what it holds and when it goes", () => {
    render(<PrivacyPage />);
    const section = screen.getByRole("heading", { name: "Data stored in your browser" }).closest("section");
    const text = section?.textContent ?? "";
    expect(text).toMatch(/Load my history or\s+Keep on this device in Daily Pulse, this browser also\s+keeps a copy of your game history/);
    expect(text).toMatch(/only for accounts\s+with up to 20,000 games/);
    expect(text).toMatch(/Battle\.net character\s+ID and SC2Pulse IDs/);
    expect(text).toMatch(/it is not sent back to us/);
    expect(text).toMatch(/removed when you sign out or another account signs in/);
    expect(text).toMatch(/Deleting your account removes it from each browser/);
    expect(section?.querySelectorAll('a[href="/settings?tab=backups"]').length).toBe(2);
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

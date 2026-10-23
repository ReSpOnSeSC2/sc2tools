import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PrivacyPage from "../page";

afterEach(cleanup);

describe("privacy policy backups", () => {
  it("explains the daily Atlas backups, user snapshots and export", () => {
    render(<PrivacyPage />);

    const heading = screen.getByRole("heading", { name: "Backups" });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    const text = section!.textContent || "";
    expect(text).toMatch(/MongoDB Atlas takes\s+automatic snapshots of the whole SC2 Tools database every day/);
    expect(text).toMatch(/deleted\s+automatically when their retention period/);
    expect(text).toMatch(/not a\s+way to restore one account on request/);
    expect(text).toMatch(/stays until\s+you delete your account/);
    expect(text).toMatch(/Copies already inside database backups are not edited/);
    expect(section!.querySelector('a[href="/settings?tab=backups"]')).not.toBeNull();
  });

  it("points the deletion promise at the backup expiry", () => {
    render(<PrivacyPage />);
    const rights = screen.getByRole("heading", { name: "Your rights" }).closest("section");
    expect(rights?.textContent).toMatch(/Copies in our daily database\s+backups expire on their own/);
  });
});

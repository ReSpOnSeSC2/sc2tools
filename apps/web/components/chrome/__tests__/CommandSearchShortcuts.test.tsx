import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false, userId: null, getToken: async () => null }) }));

import CommandSearchRuntime from "../CommandSearchRuntime";
import type { CommandFrame } from "../CommandSearchProvider";
import { registerPageShortcuts } from "@/lib/pageShortcuts";
import { REVIEW_SHORTCUTS } from "@/lib/reviewNavigation";

afterEach(cleanup);

describe("global keyboard shortcuts sheet", () => {
  it("lists the open page's own keys under This page, only while the page registers them", () => {
    const frame = { mode: "shortcuts", returnFocus: null } as unknown as CommandFrame;
    render(<CommandSearchRuntime frame={frame} navigation={[]} onClose={() => {}} onSelect={() => {}}
      onQueryEdit={() => null} onPrivateSelect={() => false} />);
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).queryByRole("region", { name: "This page" })).toBeNull();
    let unregister = () => {};
    act(() => { unregister = registerPageShortcuts([{ title: "This page", items: REVIEW_SHORTCUTS }]); });
    const page = within(sheet).getByRole("region", { name: "This page" });
    expect(within(page).getByText("N").nextElementSibling?.textContent).toBe("Next timed comment");
    expect(within(page).getByText("C").nextElementSibling?.textContent).toBe("Comment at the current replay time");
    act(() => unregister());
    expect(within(sheet).queryByRole("region", { name: "This page" })).toBeNull();
  });
});

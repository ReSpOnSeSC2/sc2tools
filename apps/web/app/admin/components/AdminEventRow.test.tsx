import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AdminEventRow } from "./AdminEventRow";
import type { AdminEvent } from "./adminTypes";

afterEach(cleanup);

function signupEvent(
  email: string | null,
  clerkUserId: string | null = "user_clerk_id",
): AdminEvent {
  return {
    eventId: "signup-1",
    type: "user_signup",
    payload: {
      clerkUserId,
      userId: "internal-user-id",
      email,
      source: "first_touch",
    },
    createdAt: new Date().toISOString(),
    readAt: null,
  };
}

describe("AdminEventRow signup identity", () => {
  it("shows the signup email instead of the Clerk user ID", () => {
    render(
      <ul>
        <AdminEventRow
          event={signupEvent("new-user@example.com")}
          unread
        />
      </ul>,
    );

    expect(screen.getByText(/new-user@example\.com · via first sign-in/)).toBeTruthy();
    expect(screen.queryByText(/user_clerk_id/)).toBeNull();
  });

  it("falls back to the Clerk user ID while email is unavailable", () => {
    render(
      <ul>
        <AdminEventRow event={signupEvent(null)} unread />
      </ul>,
    );

    expect(screen.getByText(/user_clerk_id · via first sign-in/)).toBeTruthy();
  });

  it("does not expose a blank identifier after account deletion", () => {
    render(
      <ul>
        <AdminEventRow event={signupEvent(null, null)} unread={false} />
      </ul>,
    );

    expect(screen.getByText(/Email unavailable · via first sign-in/)).toBeTruthy();
  });
});

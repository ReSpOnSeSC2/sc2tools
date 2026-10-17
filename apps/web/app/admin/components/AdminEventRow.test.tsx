import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AdminEventRow } from "./AdminEventRow";
import type { AdminEvent, AdminEventAgentConnectedPayload } from "./adminTypes";

afterEach(cleanup);

it("identifies external email and links to the original Gmail message", () => {
  const event: AdminEvent = {
    eventId: "mail-1", type: "user_message", createdAt: new Date().toISOString(), readAt: null,
    payload: { userId: null, clerkUserId: null, email: "reporter@example.com",
      subject: "Live Overlay bug", message: "Wrong opponent", source: "email",
      mailbox: "responsecoaching@gmail.com", gmailMessageId: "abc123" },
  };
  render(<ul><AdminEventRow event={event} unread /></ul>);
  expect(screen.getByText("from reporter@example.com · via email")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open original email in Gmail" }).getAttribute("href"))
    .toBe("https://mail.google.com/mail/u/?authuser=responsecoaching%40gmail.com#all/abc123");
});

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

function connectedEvent(payload: Partial<AdminEventAgentConnectedPayload> = {}): AdminEvent {
  return {
    eventId: "connected-1",
    type: "agent_connected",
    payload: {
      userId: "internal-user-id",
      clerkUserId: "user_clerk_id",
      email: "installed@example.com",
      deviceId: "device-1",
      platform: "windows",
      version: "0.18.9",
      source: "heartbeat",
      ...payload,
    },
    createdAt: new Date().toISOString(),
    readAt: null,
  };
}

describe("AdminEventRow confirmed installs", () => {
  it("identifies the installed agent and account separately from download clicks", () => {
    render(<ul><AdminEventRow event={connectedEvent()} unread /></ul>);

    expect(screen.getByText("Agent connected · Windows v0.18.9")).toBeTruthy();
    expect(screen.getByText("installed@example.com · confirmed by agent")).toBeTruthy();
    expect(screen.queryByText(/Agent download/)).toBeNull();
    expect(screen.queryByText(/user_clerk_id/)).toBeNull();
  });

  it.each([
    [{ email: null }, "user_clerk_id"],
    [{ email: null, clerkUserId: null }, "internal-user-id"],
    [{ email: null, clerkUserId: null, userId: null }, "Account unavailable"],
  ])("keeps a useful identity while email is unavailable", (payload, identity) => {
    render(<ul><AdminEventRow event={connectedEvent(payload)} unread={false} /></ul>);

    expect(screen.getByText(`${identity} · confirmed by agent`)).toBeTruthy();
  });

  it("omits unavailable platform and version for older agents", () => {
    render(
      <ul><AdminEventRow event={connectedEvent({ platform: "unknown", version: null })} unread /></ul>,
    );

    expect(screen.getByText("Agent connected")).toBeTruthy();
    expect(screen.queryByText(/Unknown/)).toBeNull();
  });
});

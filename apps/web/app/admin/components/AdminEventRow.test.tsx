import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "fixture-token" }) }));
import { cleanup, render, screen } from "@testing-library/react";

import { AdminEventRow } from "./AdminEventRow";
import type {
  AdminEvent,
  AdminEventAgentConnectedPayload,
  AdminEventBackupStalePayload,
  AdminEventUserMessagePayload,
} from "./adminTypes";

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

describe("AdminEventRow in-app reports", () => {
  function reportEvent(payload: Partial<AdminEventUserMessagePayload> = {}): AdminEvent {
    return {
      eventId: "report-1", type: "user_message", createdAt: new Date().toISOString(), readAt: null,
      payload: {
        userId: "u1", clerkUserId: "user_1", email: "player@example.com",
        subject: "Opponents page is blank", message: "Spins forever.", ...payload,
      },
    };
  }

  it("tags the report type and shows its context as a compact line", () => {
    render(
      <ul>
        <AdminEventRow
          event={reportEvent({
            type: "problem",
            context: {
              page: "/app/opponents/1-S2-1-99",
              build: "4f9c2ab1d0e3",
              viewport: "1440x900",
              browser: "Chrome 129 on Windows",
              agentVersion: "0.19.0",
              agentStatus: "online",
              failedRequests: [
                { path: "/v1/me", status: 502 },
                { path: "/v1/games", status: 500, code: "internal_error", requestId: "req_2" },
              ],
            },
          })}
          unread
        />
      </ul>,
    );
    expect(screen.getByText("Problem")).toBeTruthy();
    expect(
      screen.getByText(
        "/app/opponents/1-S2-1-99 · build 4f9c2ab1d0e3 · 1440×900 · Chrome 129 on Windows · app v0.19.0, online",
      ),
    ).toBeTruthy();
    expect(screen.getByText("2 failed requests")).toBeTruthy();
    const lines = screen.getAllByRole("listitem").slice(1).map((li) => li.textContent);
    expect(lines).toEqual(["500 · /v1/games · internal_error · ref req_2", "502 · /v1/me"]);
  });

  it("keeps older reports without a type or context unchanged", () => {
    render(<ul><AdminEventRow event={reportEvent()} unread={false} /></ul>);
    expect(screen.getByText("Opponents page is blank")).toBeTruthy();
    expect(screen.queryByText("Problem")).toBeNull();
    expect(screen.queryByText(/failed request/)).toBeNull();
  });

  it.each([
    ["idea", "Idea"],
    ["question", "Question"],
  ] as const)("labels a %s", (type, label) => {
    render(<ul><AdminEventRow event={reportEvent({ type, context: { agentStatus: "not_paired" } })} unread /></ul>);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText("app not paired")).toBeTruthy();
  });
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

describe("AdminEventRow backup alerts", () => {
  function backupEvent(payload: Partial<AdminEventBackupStalePayload>): AdminEvent {
    return {
      eventId: "backup-1",
      type: "backup_stale",
      payload: {
        reason: "stale",
        lastSnapshotAt: "2026-08-09T12:00:00.000Z",
        ageHours: 53.5,
        latestStatus: "completed",
        ...payload,
      },
      createdAt: new Date().toISOString(),
      readAt: null,
    };
  }

  it("says how old the newest snapshot is and where to look", () => {
    render(<ul><AdminEventRow event={backupEvent({ latestStatus: "failed" })} unread /></ul>);

    expect(screen.getByText("Database backup is overdue")).toBeTruthy();
    expect(
      screen.getByText("Newest Atlas snapshot is 53 h old · newest run failed · see Infrastructure"),
    ).toBeTruthy();
  });

  it("calls out a cluster with no snapshot at all", () => {
    render(
      <ul><AdminEventRow event={backupEvent({ reason: "missing", lastSnapshotAt: null, ageHours: null })} unread /></ul>,
    );

    expect(screen.getByText("No database backup found")).toBeTruthy();
    expect(screen.getByText("Atlas has no completed snapshot · see Infrastructure")).toBeTruthy();
  });
});

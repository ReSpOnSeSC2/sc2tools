"use client";

import { Download, MessageSquareWarning, UserPlus } from "lucide-react";
import { timeSince } from "./format";
import type {
  AdminEvent,
  AdminEventDownloadPayload,
  AdminEventSignupPayload,
  AdminEventUserMessagePayload,
} from "./adminTypes";

/**
 * Single notification row. Used by both the dashboard's "Recent
 * activity" card and the full notifications feed. Renders an icon,
 * a primary line ("New signup", "Agent download · Windows"), a
 * secondary detail line, and a relative timestamp on the right.
 */
export function AdminEventRow({
  event,
  unread,
}: {
  event: AdminEvent;
  unread: boolean;
}) {
  const meta = describe(event);
  return (
    <li
      className={[
        "flex items-start gap-3 px-4 py-3 transition-colors",
        unread ? "bg-accent-cyan/[0.06]" : "",
      ].join(" ")}
    >
      <span
        className={[
          "mt-0.5 inline-flex h-9 w-9 flex-none items-center justify-center rounded-full border",
          ICON_CLASSES[event.type],
        ].join(" ")}
        aria-hidden
      >
        <EventIcon type={event.type} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-semibold text-text">
            {meta.title}
          </span>
          {unread ? (
            <span className="inline-flex h-1.5 w-1.5 flex-none rounded-full bg-accent-cyan" />
          ) : null}
        </div>
        {meta.subtitle ? (
          <p className="truncate text-caption text-text-muted">
            {meta.subtitle}
          </p>
        ) : null}
        {meta.body ? (
          <p className="mt-1.5 whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-elevated/40 px-3 py-2 text-caption text-text-muted">
            {meta.body}
          </p>
        ) : null}
      </div>
      <span className="flex-none whitespace-nowrap text-caption text-text-dim">
        {timeSince(event.createdAt)}
      </span>
    </li>
  );
}

const ICON_CLASSES: Record<AdminEvent["type"], string> = {
  user_signup: "border-accent/40 bg-accent/10 text-accent",
  agent_download: "border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan",
  user_message: "border-warning/40 bg-warning/10 text-warning",
};

function EventIcon({ type }: { type: AdminEvent["type"] }) {
  if (type === "user_signup") return <UserPlus className="h-4 w-4" />;
  if (type === "user_message")
    return <MessageSquareWarning className="h-4 w-4" />;
  return <Download className="h-4 w-4" />;
}

function describe(event: AdminEvent): {
  title: string;
  subtitle: string;
  body?: string;
} {
  if (event.type === "user_signup") {
    const p = event.payload as AdminEventSignupPayload;
    const identity = p.email || p.clerkUserId || "Email unavailable";
    return {
      title: "New signup",
      subtitle: `${identity} · via ${humanSource(p.source)}`,
    };
  }
  if (event.type === "user_message") {
    const p = event.payload as AdminEventUserMessagePayload;
    const from = p.email || p.clerkUserId || "a signed-in user";
    return {
      title: p.subject || "User message",
      subtitle: `from ${from}`,
      body: p.message,
    };
  }
  const p = event.payload as AdminEventDownloadPayload;
  const version = p.version ? ` v${p.version}` : "";
  return {
    title: `Agent download · ${humanPlatform(p.platform)}${version}`,
    subtitle: p.ip ? `from ${p.ip}` : "",
  };
}

function humanPlatform(p: AdminEventDownloadPayload["platform"]): string {
  switch (p) {
    case "windows":
      return "Windows";
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return "Unknown";
  }
}

function humanSource(source: string): string {
  switch (source) {
    case "clerk_webhook":
      return "Clerk webhook";
    case "first_touch":
      return "first sign-in";
    default:
      return source || "unknown";
  }
}

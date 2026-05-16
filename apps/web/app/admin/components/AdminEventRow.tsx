"use client";

import { Download, UserPlus } from "lucide-react";
import { timeSince } from "./format";
import type {
  AdminEvent,
  AdminEventDownloadPayload,
  AdminEventSignupPayload,
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
          event.type === "user_signup"
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan",
        ].join(" ")}
        aria-hidden
      >
        {event.type === "user_signup" ? (
          <UserPlus className="h-4 w-4" />
        ) : (
          <Download className="h-4 w-4" />
        )}
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
      </div>
      <span className="flex-none whitespace-nowrap text-caption text-text-dim">
        {timeSince(event.createdAt)}
      </span>
    </li>
  );
}

function describe(event: AdminEvent): { title: string; subtitle: string } {
  if (event.type === "user_signup") {
    const p = event.payload as AdminEventSignupPayload;
    return {
      title: "New signup",
      subtitle: p.email
        ? `${p.email} · via ${humanSource(p.source)}`
        : `${p.clerkUserId} · via ${humanSource(p.source)}`,
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

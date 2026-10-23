"use client";

import {
  DatabaseBackup,
  Download,
  MessageSquareWarning,
  MonitorCheck,
  UserPlus,
} from "lucide-react";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import {
  describeFailedRequest,
  summariseReportContext,
  type ReportType,
} from "@/lib/feedback/reportContext";
import { timeSince } from "./format";
import type {
  AdminEvent,
  AdminEventAgentConnectedPayload,
  AdminEventBackupStalePayload,
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
  const report = event.type === "user_message" ? (event.payload as AdminEventUserMessagePayload) : null;
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
          {report?.type ? <ReportTypeBadge type={report.type} /> : null}
          {unread ? (
            <span className="inline-flex h-1.5 w-1.5 flex-none rounded-full bg-accent-cyan" />
          ) : null}
        </div>
        {meta.subtitle ? (
          <p className="truncate text-caption text-text-muted">
            {meta.subtitle}
          </p>
        ) : null}
        {report?.context ? <ReportContextLines payload={report} /> : null}
        {meta.body ? (
          <p className="mt-1.5 whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-elevated/40 px-3 py-2 text-caption text-text-muted">
            {meta.body}
          </p>
        ) : null}
        {report ? <EmailSource payload={report} /> : null}
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
  agent_connected: "border-success/40 bg-success/10 text-success",
  user_message: "border-warning/40 bg-warning/10 text-warning",
  backup_stale: "border-danger/40 bg-danger/10 text-danger",
};

function EventIcon({ type }: { type: AdminEvent["type"] }) {
  if (type === "user_signup") return <UserPlus className="h-4 w-4" />;
  if (type === "agent_connected") return <MonitorCheck className="h-4 w-4" />;
  if (type === "user_message")
    return <MessageSquareWarning className="h-4 w-4" />;
  if (type === "backup_stale") return <DatabaseBackup className="h-4 w-4" />;
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
      subtitle: `from ${from}${p.source === "email" ? " · via email" : ""}`,
      body: p.message,
    };
  }
  if (event.type === "backup_stale") {
    return describeBackupStale(event.payload as AdminEventBackupStalePayload);
  }
  if (event.type === "agent_connected") {
    const p = event.payload as AdminEventAgentConnectedPayload;
    const identity = p.email || p.clerkUserId || p.userId || "Account unavailable";
    const platform = p.platform && p.platform !== "unknown"
      ? ` · ${humanPlatform(p.platform)}`
      : "";
    const version = p.version ? ` v${p.version}` : "";
    return {
      title: `Agent connected${platform}${version}`,
      subtitle: `${identity} · confirmed by agent`,
    };
  }
  const p = event.payload as AdminEventDownloadPayload;
  const version = p.version ? ` v${p.version}` : "";
  return {
    title: `Agent download · ${humanPlatform(p.platform)}${version}`,
    subtitle: p.ip ? `from ${p.ip}` : "",
  };
}

const REPORT_TYPE_BADGE: Record<ReportType, { label: string; variant: BadgeVariant }> = {
  problem: { label: "Problem", variant: "danger" },
  idea: { label: "Idea", variant: "cyan" },
  question: { label: "Question", variant: "neutral" },
};

function ReportTypeBadge({ type }: { type: ReportType }) {
  const badge = REPORT_TYPE_BADGE[type];
  if (!badge) return null;
  return (
    <Badge size="sm" variant={badge.variant} className="flex-none">
      {badge.label}
    </Badge>
  );
}

/**
 * The diagnostics a report carried: page, build, window size, browser and
 * desktop app on one compact line, then any failed requests (collapsed).
 */
function ReportContextLines({ payload }: { payload: AdminEventUserMessagePayload }) {
  const context = payload.context;
  if (!context) return null;
  const summary = summariseReportContext(context);
  const requests = context.failedRequests ?? [];
  return (
    <div className="mt-0.5 space-y-1">
      {summary ? (
        <p className="break-words font-mono text-micro text-text-dim" title={summary}>
          {summary}
        </p>
      ) : null}
      {requests.length > 0 ? (
        <details className="text-micro text-text-dim">
          <summary className="cursor-pointer select-none rounded-sm font-semibold text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {requests.length === 1 ? "1 failed request" : `${requests.length} failed requests`}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {[...requests].reverse().map((request, index) => (
              <li key={`${index}:${request.path}`} className="break-all font-mono">
                {describeFailedRequest(request)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function describeBackupStale(p: AdminEventBackupStalePayload): {
  title: string;
  subtitle: string;
} {
  if (p.reason === "missing" || !p.lastSnapshotAt) {
    return {
      title: "No database backup found",
      subtitle: "Atlas has no completed snapshot · see Infrastructure",
    };
  }
  const age = p.ageHours !== null ? `${Math.floor(p.ageHours)} h old` : `taken ${timeSince(p.lastSnapshotAt)}`;
  const failed = p.latestStatus === "failed" ? " · newest run failed" : "";
  return {
    title: "Database backup is overdue",
    subtitle: `Newest Atlas snapshot is ${age}${failed} · see Infrastructure`,
  };
}

function EmailSource({ payload }: { payload: AdminEventUserMessagePayload }) {
  if (payload.source !== "email" || !payload.mailbox ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(payload.gmailMessageId || "")) return null;
  const url = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(payload.mailbox)}#all/${payload.gmailMessageId}`;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="mt-2 inline-block text-caption text-accent-cyan underline-offset-2 hover:underline">
      Open original email in Gmail
    </a>
  );
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

"use client";

import Link from "next/link";
import {
  ArrowRight,
  Cloud,
  Calendar,
  PackageCheck,
  Mail,
  IdCard,
} from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { fmtAgo } from "@/lib/format";

type Me = {
  userId: string;
  email?: string | null;
  source?: string;
  games?: { total: number; latest: string | null };
  agentVersion?: string | null;
  agentPaired?: boolean;
};

type RowIcon = typeof Mail;

interface SummaryRow {
  label: string;
  value: string;
  Icon: RowIcon;
  mono?: boolean;
}

const QUICK_LINKS: ReadonlyArray<{
  href: string;
  label: string;
  description: string;
}> = [
  {
    href: "/devices",
    label: "Devices",
    description: "Pair the desktop agent or extra browsers",
  },
  {
    href: "/settings#overlay",
    label: "Streaming overlay",
    description: "Copy OBS browser-source URLs",
  },
  {
    href: "/builds",
    label: "Personal build library",
    description: "Saved openers and matchup notes",
  },
  {
    href: "/download",
    label: "Download / update agent",
    description: "Latest desktop client + release notes",
  },
  {
    href: "/donate",
    label: "Donate / support",
    description: "Render, MongoDB, the domain — see where it goes",
  },
];

export function SettingsFoundation() {
  const me = useApi<Me>("/v1/me");

  if (me.isLoading) return <Skeleton rows={3} />;
  if (!me.data) {
    return (
      <Card>
        <p className="text-danger">Couldn&rsquo;t load your account.</p>
      </Card>
    );
  }

  const games = me.data.games ?? { total: 0, latest: null };
  const rows: SummaryRow[] = [
    { label: "Email", value: me.data.email || "—", Icon: Mail },
    { label: "Cloud user ID", value: me.data.userId, Icon: IdCard, mono: true },
    {
      label: "Games synced",
      value: String(games.total),
      Icon: Cloud,
    },
    {
      label: "Latest sync",
      value: games.latest ? fmtAgo(games.latest) : "—",
      Icon: Calendar,
    },
    {
      label: "Agent version",
      value:
        me.data.agentVersion ||
        (me.data.agentPaired ? "Unknown" : "Not paired"),
      Icon: PackageCheck,
    },
  ];

  return (
    <div className="space-y-6">
      <Section
        title="Account"
        description="Read-only summary of your cloud profile and the data we already have."
      >
        <Card>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {rows.map((row) => (
              <SummaryRowItem key={row.label} {...row} />
            ))}
          </dl>
        </Card>
      </Section>

      <Section
        title="Quick links"
        description="Jump to the management surfaces for your devices, overlays, and builds."
      >
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {QUICK_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
                >
                  <div className="min-w-0">
                    <div className="text-body font-medium text-text">
                      {link.label}
                    </div>
                    <div className="text-caption text-text-muted">
                      {link.description}
                    </div>
                  </div>
                  <ArrowRight
                    className="h-4 w-4 flex-shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent-cyan"
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </Section>
    </div>
  );
}

function SummaryRowItem({ label, value, Icon, mono }: SummaryRow) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 flex-shrink-0 text-text-muted" aria-hidden />
        <dt className="text-caption text-text-muted">{label}</dt>
      </div>
      <dd
        className={[
          "min-w-0 text-right text-body text-text",
          mono ? "truncate font-mono text-caption" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={mono ? value : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

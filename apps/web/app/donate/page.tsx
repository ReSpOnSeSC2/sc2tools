import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Cloud,
  Database,
  ExternalLink,
  Globe,
  Heart,
  Server,
  ShieldCheck,
  Sparkles,
  Tv,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge, Card, GlowHalo, Section } from "@/components/ui";

export const metadata = {
  alternates: { canonical: "/donate" },
  title: "Support SC2 Tools — Donate",
  description:
    "SC2 Tools is free for everyone. If it's helping your ladder grind, you can chip in via Streamlabs or PayPal.",
};

const STREAMLABS_URL = "https://streamlabs.com/responsesc2/tip";
const PAYPAL_EMAIL = "jay1988stud@gmail.com";
const PAYPAL_URL = `https://www.paypal.com/donate/?business=${encodeURIComponent(
  PAYPAL_EMAIL,
)}&currency_code=USD`;

interface DonationChannel {
  id: string;
  name: string;
  href: string;
  blurb: string;
  detail: ReactNode;
  cta: string;
}

const CHANNELS: ReadonlyArray<DonationChannel> = [
  {
    id: "streamlabs",
    name: "Streamlabs Tip",
    href: STREAMLABS_URL,
    blurb:
      "Tip via the Streamlabs page used by my Twitch stream. Card or direct bank checkout — no Streamlabs account required.",
    detail: (
      <>
        Tips on stream get a shout-out live; off-stream tips get a thank-you
        DM the next time I&rsquo;m online.
      </>
    ),
    cta: "Tip on Streamlabs",
  },
  {
    id: "paypal",
    name: "PayPal",
    href: PAYPAL_URL,
    blurb:
      "PayPal donate flow with the SC2 Tools account pre-filled. Send any amount, no fees on personal payments.",
    detail: (
      <>
        Or send directly to{" "}
        <code className="rounded bg-bg-elevated px-1.5 py-0.5 font-mono text-caption">
          {PAYPAL_EMAIL}
        </code>{" "}
        from your PayPal app.
      </>
    ),
    cta: "Open PayPal",
  },
];

export default function DonatePage() {
  return (
    <div className="space-y-12">
      <HeroBlock />
      <Section
        title="Two ways to chip in"
        description="Either channel goes to the same person. Pick whichever is easier."
        className="mx-auto max-w-5xl"
      >
        <ul className="grid gap-4 md:grid-cols-2">
          {CHANNELS.map((c) => (
            <li key={c.id} className="h-full">
              <DonationCard channel={c} />
            </li>
          ))}
        </ul>
      </Section>
      <CostBreakdown />
      <FaqBlock />
    </div>
  );
}

function HeroBlock() {
  return (
    <section className="relative mx-auto max-w-3xl text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <GlowHalo color="cyan" position="center" size={70} opacity={0.6} />
      </div>
      <Badge
        variant="cyan"
        iconLeft={<Heart className="h-3.5 w-3.5" aria-hidden />}
      >
        Support SC2 Tools
      </Badge>
      <h1 className="mt-3 text-h1 font-bold tracking-tight md:text-display-lg">
        SC2 Tools is free.
        <br />
        <span className="text-accent-cyan">Donations keep it that way.</span>
      </h1>
      <p className="mx-auto mt-4 max-w-2xl text-body-lg text-text-muted">
        Every feature ships free for every player. The current public-list-price
        infrastructure base is about $65.19/month at the repository&rsquo;s
        declared Render Starter tier: one Render-hosted API, MongoDB Atlas M10
        and the domain. A one-time tip helps cover that bill while the website,
        authentication and current replay archive remain within or close to
        their included allowances.
      </p>
    </section>
  );
}

function DonationCard({ channel }: { channel: DonationChannel }) {
  return (
    <Card padded={false} className="h-full">
      <div className="flex h-full flex-col gap-4 p-5 md:p-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
          >
            {channel.id === "streamlabs" ? (
              <Tv className="h-5 w-5" />
            ) : (
              <Sparkles className="h-5 w-5" />
            )}
          </span>
          <div>
            <h3 className="text-h4 font-semibold text-text">{channel.name}</h3>
          </div>
        </div>
        <p className="text-body text-text">{channel.blurb}</p>
        <p className="text-caption text-text-muted">{channel.detail}</p>
        <a
          href={channel.href}
          target="_blank"
          rel="noopener"
          className="mt-auto inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-body font-semibold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {channel.cta}
          <ExternalLink className="h-4 w-4" aria-hidden />
        </a>
      </div>
    </Card>
  );
}

interface CostLine {
  id: string;
  icon: LucideIcon;
  label: string;
  detail: string;
  /** Public list-price equivalent in USD/month. */
  approxMonthlyUsd: number;
  /** Fixed costs participate in the base monthly and annual totals. */
  includedInBase: boolean;
  /** Override the standard monthly-price rendering for included/variable rows. */
  priceLabel?: string;
  /** Optional supporting label below the primary price. */
  priceNote?: string;
  /** Set when billed annually so annual math follows the real billing period. */
  approxYearlyUsd?: number;
  /** Optional public pricing-page link so the figures are auditable. */
  pricingHref?: string;
}

const COST_LINES: ReadonlyArray<CostLine> = [
  {
    id: "render",
    icon: Server,
    label: "Render — Starter API instance",
    detail:
      "One always-on instance runs the Express + Socket.io API, replay sync, parser jobs and live overlays. The Next.js website is hosted separately on Vercel.",
    approxMonthlyUsd: 7,
    includedInBase: true,
    pricingHref: "https://render.com/pricing",
  },
  {
    id: "mongo",
    icon: Database,
    label: "MongoDB Atlas — M10",
    detail:
      "Dedicated M10 base tier for accounts, searchable replay metadata, opponent histories and aggregates. Backups, added storage and data transfer are usage-priced separately.",
    approxMonthlyUsd: 56.94,
    includedInBase: true,
    pricingHref: "https://www.mongodb.com/pricing",
  },
  {
    id: "domain",
    icon: Globe,
    label: "sc2tools.com domain",
    detail:
      "Annual .com registration so the project has a stable home. The actual renewal can vary by registrar.",
    approxMonthlyUsd: 1.25,
    includedInBase: true,
    approxYearlyUsd: 15,
  },
  {
    id: "r2",
    icon: Cloud,
    label: "Cloudflare R2 — private replay archive",
    detail:
      "Stores original .SC2Replay files and detailed analysis objects. Standard storage includes the first 10 GB each month, then costs $0.015 per GB-month; monthly operation allowances apply, and direct R2 egress is free.",
    approxMonthlyUsd: 0,
    includedInBase: false,
    priceLabel: "$0–$0.08/mo",
    priceNote: "current estimate",
    pricingHref: "https://developers.cloudflare.com/r2/pricing/",
  },
  {
    id: "vercel",
    icon: Tv,
    label: "Vercel — Next.js website",
    detail:
      "Hosts the frontend and edge delivery. This estimate assumes the repo-declared deployment remains eligible for Vercel Hobby and within its included usage.",
    approxMonthlyUsd: 0,
    includedInBase: false,
    priceLabel: "$0/mo",
    priceNote: "Hobby allowance",
    pricingHref: "https://vercel.com/pricing",
  },
  {
    id: "clerk",
    icon: ShieldCheck,
    label: "Clerk — sign-in and accounts",
    detail:
      "Provides authentication. The Hobby allowance includes up to 50,000 monthly retained users per application, well above today's membership.",
    approxMonthlyUsd: 0,
    includedInBase: false,
    priceLabel: "$0/mo",
    priceNote: "Hobby allowance",
    pricingHref: "https://clerk.com/pricing",
  },
];

const BASE_COST_LINES = COST_LINES.filter((line) => line.includedInBase);
const APPROX_MONTHLY_BASE = BASE_COST_LINES.reduce(
  (acc, line) => acc + line.approxMonthlyUsd,
  0,
);
const APPROX_YEARLY_BASE = BASE_COST_LINES.reduce(
  (acc, line) =>
    acc + (line.approxYearlyUsd ?? line.approxMonthlyUsd * 12),
  0,
);

function fmtUsd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function CostBreakdown() {
  return (
    <Section
      title="Where every penny goes"
      description="No ads and no investor money. This is a public-list-price estimate for the tiers declared in the repository, not a live invoice; provider dashboards remain the source of truth."
      className="mx-auto max-w-5xl"
    >
      <Card padded={false}>
        <ul className="divide-y divide-border">
          {COST_LINES.map((line) => (
            <CostRow key={line.id} line={line} />
          ))}
        </ul>
        <div className="grid gap-2 border-t border-border bg-bg-elevated/40 px-5 py-4 sm:grid-cols-2">
          <div className="space-y-0.5">
            <p className="text-caption font-semibold uppercase tracking-wider text-text-muted">
              Fixed base · monthly equivalent
            </p>
            <p className="text-h3 font-semibold tabular-nums text-text">
              ~{fmtUsd(APPROX_MONTHLY_BASE)}
              <span className="ml-1 text-caption font-normal text-text-muted">
                /month
              </span>
            </p>
          </div>
          <div className="space-y-0.5 sm:text-right">
            <p className="text-caption font-semibold uppercase tracking-wider text-text-muted">
              Fixed base · annualised
            </p>
            <p className="text-h3 font-semibold tabular-nums text-text">
              ~{fmtUsd(APPROX_YEARLY_BASE)}
              <span className="ml-1 text-caption font-normal text-text-muted">
                /year
              </span>
            </p>
          </div>
        </div>
      </Card>
      <div className="mt-4 max-w-3xl space-y-2 text-caption text-text-muted">
        <p>
          At today&rsquo;s scale, R2 is estimated to add $0–$0.08/month, so the
          current total remains about $65/month before variable Atlas or
          Render usage, taxes and provider-specific adjustments.
        </p>
        <p>
          This assumes Render&rsquo;s no-fee Hobby workspace. A Render Pro
          workspace is a separate $25/month operations subscription; buying it
          alone does not add API CPU or memory. Capacity changes come from the
          web service&rsquo;s Starter, Standard or Pro instance type.
        </p>
        <p>
          At the planning target of 1,000 members with 10,000 replays each,
          measured repository samples put the R2 archive near 994 GB and
          about $14.76/month for storage. That is a storage estimate, not a
          whole-site capacity promise: database and API tiers would be reviewed
          separately, and real replay sizes and access patterns will vary.
        </p>
        <p>
          R2 operations are separate. If all 10 million originals and analysis
          objects were backfilled in one billing month, the current direct
          upload-and-promote flow would be roughly $130 in one-time Class A
          operation charges after the monthly free allowance. Organic growth
          spreads those operations across monthly allowances.
        </p>
      </div>
    </Section>
  );
}

function CostRow({ line }: { line: CostLine }) {
  const Icon = line.icon;
  return (
    <li className="flex flex-wrap items-start gap-3 px-5 py-3">
      <span
        aria-hidden
        className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold text-text">{line.label}</p>
        <p className="text-caption text-text-muted">{line.detail}</p>
        {line.pricingHref ? (
          <a
            href={line.pricingHref}
            target="_blank"
            rel="noopener"
            className="mt-1 inline-flex items-center gap-1 text-caption text-accent-cyan hover:underline"
          >
            Pricing page
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : null}
      </div>
      <div className="text-right tabular-nums">
        <p className="text-body font-semibold text-text">
          {line.priceLabel ?? `~${fmtUsd(line.approxMonthlyUsd)}`}
          {!line.priceLabel ? (
            <span className="ml-1 text-caption font-normal text-text-muted">
              /mo
            </span>
          ) : null}
        </p>
        {line.priceNote ? (
          <p className="text-caption text-text-dim">{line.priceNote}</p>
        ) : line.approxYearlyUsd ? (
          <p className="text-caption text-text-dim">
            (~{fmtUsd(line.approxYearlyUsd)}/yr billed)
          </p>
        ) : null}
      </div>
    </li>
  );
}

function FaqBlock() {
  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <header className="text-center">
        <h2 className="text-h2 font-semibold">Frequently asked</h2>
      </header>
      <ul className="space-y-3">
        <FaqItem
          q="Do donors get extra features?"
          a="No. Every feature is free for every player. Donations are voluntary and don't unlock anything — they keep the API and the cloud database paid for."
        />
        <FaqItem
          q="Are donations refundable?"
          a="They're processed by Streamlabs / PayPal as personal payments. If something went wrong, ping me on the relevant channel and I'll sort it out."
        />
        <FaqItem
          q="Is there a recurring tier?"
          a="Not yet. One-time tips only. If a small recurring tier would be useful let me know on GitHub."
        />
      </ul>
      <p className="pt-4 text-center text-caption text-text-muted">
        Prefer to help with code or bug reports?{" "}
        <Link
          href="https://github.com/ReSpOnSeSC2/sc2tools/issues"
          className="inline-flex items-center gap-1 text-accent-cyan hover:underline"
        >
          Open a ticket on GitHub
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </p>
    </section>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <li>
      <Card padded={false}>
        <div className="space-y-1.5 p-4">
          <p className="flex items-center gap-2 text-body font-semibold text-text">
            <ShieldCheck className="h-4 w-4 text-accent-cyan" aria-hidden />
            {q}
          </p>
          <p className="text-caption text-text-muted">{a}</p>
        </div>
      </Card>
    </li>
  );
}

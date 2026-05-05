import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
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
        Every feature ships free for every player. If the agent, dossiers, or
        overlay save you ladder anxiety, a one-time tip helps cover the
        Render-hosted API, MongoDB, and the time spent shipping new pillars.
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
  /** Approx list price in USD/month. Rendered as "~$N / mo". */
  approxMonthlyUsd: number;
  /** Set when billed annually; we show both the per-month + per-year. */
  approxYearlyUsd?: number;
  /** Optional public pricing-page link so the figures are auditable. */
  pricingHref?: string;
}

const COST_LINES: ReadonlyArray<CostLine> = [
  {
    id: "render",
    icon: Server,
    label: "Render — paid web service",
    detail:
      "One paid Render subscription. Runs the Express + Socket.io API (auth, replay sync, live overlay event bus) plus the Next.js frontend you're reading this on.",
    approxMonthlyUsd: 25,
    pricingHref: "https://render.com/pricing",
  },
  {
    id: "mongo",
    icon: Database,
    label: "MongoDB Atlas — M10",
    detail:
      "Dedicated M10 cluster with automated backups. Stores every parsed game for every signed-in player.",
    approxMonthlyUsd: 57,
    pricingHref: "https://www.mongodb.com/pricing",
  },
  {
    id: "domain",
    icon: Globe,
    label: "sc2tools.com domain",
    detail:
      "Annual .com registration so the project has a home that won't disappear.",
    approxMonthlyUsd: 1,
    approxYearlyUsd: 15,
  },
];

const APPROX_MONTHLY_TOTAL = COST_LINES.reduce(
  (acc, l) => acc + l.approxMonthlyUsd,
  0,
);
const APPROX_YEARLY_TOTAL = APPROX_MONTHLY_TOTAL * 12;

function fmtUsd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function CostBreakdown() {
  return (
    <Section
      title="Where every penny goes"
      description="No ads, no investor money. Each figure below is the public list-price approximation for the tier we're on — auditable via the linked pricing page."
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
              Approx monthly run cost
            </p>
            <p className="text-h3 font-semibold tabular-nums text-text">
              ~{fmtUsd(APPROX_MONTHLY_TOTAL)}
              <span className="ml-1 text-caption font-normal text-text-muted">
                /month
              </span>
            </p>
          </div>
          <div className="space-y-0.5 sm:text-right">
            <p className="text-caption font-semibold uppercase tracking-wider text-text-muted">
              Approx annualised
            </p>
            <p className="text-h3 font-semibold tabular-nums text-text">
              ~{fmtUsd(APPROX_YEARLY_TOTAL)}
              <span className="ml-1 text-caption font-normal text-text-muted">
                /year
              </span>
            </p>
          </div>
        </div>
      </Card>
      <p className="mt-4 max-w-3xl text-caption text-text-muted">
        These are vendor list prices, not invoiced totals — the actual bill
        wobbles a few dollars with usage. There&rsquo;s no salary line, no
        marketing line, no overhead. Every penny tipped goes against this
        bill, and even a small tip helps: $5 covers a few days on the Render
        service or roughly two days of MongoDB. Thank you.
      </p>
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
          ~{fmtUsd(line.approxMonthlyUsd)}
          <span className="ml-1 text-caption font-normal text-text-muted">
            /mo
          </span>
        </p>
        {line.approxYearlyUsd ? (
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

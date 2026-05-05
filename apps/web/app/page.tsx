import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Brain,
  CheckCircle2,
  Cloud,
  Download,
  Fingerprint,
  LayoutDashboard,
  Library,
  Map,
  Mic2,
  Shield,
  Sparkles,
  Tv,
  Wand2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Banner } from "@/components/Banner";
import {
  Badge,
  Card,
  DeviceFrame,
  GlowHalo,
  Section,
} from "@/components/ui";

/* =============================================================== */
/* PAGE                                                             */
/* =============================================================== */

export default function LandingPage() {
  return (
    <div className="space-y-24 md:space-y-32">
      <HeroSection />
      <PillarsSection />
      <ShowcaseSection />
      <HowItWorksSection />
      <SocialProofSection />
      <FinalCtaSection />
    </div>
  );
}

/* =============================================================== */
/* HERO                                                             */
/* =============================================================== */

function HeroSection() {
  return (
    <section className="relative pt-2">
      <Banner variant="hero" />
      <div className="relative mx-auto mt-10 max-w-3xl space-y-6 md:mt-14">
        <h1 className="text-[40px] font-bold leading-[44px] tracking-tight md:text-display-lg lg:text-display-xl">
          Your opponent&apos;s build,
          <br />
          <span className="text-accent-cyan">before they build it.</span>
        </h1>
        <p className="max-w-2xl text-body-lg text-text-muted">
          Sign in, install a 15&nbsp;MB agent, and every replay you finish
          surfaces an opponent dossier, build classifier, and live OBS
          overlay — across every device.
        </p>
        <div className="flex flex-wrap gap-3">
          <CtaLink
            href="/sign-up"
            iconRight={<ArrowRight className="h-5 w-5" aria-hidden />}
          >
            Get started — it&apos;s free
          </CtaLink>
          <CtaLink
            href="/download"
            variant="secondary"
            iconLeft={<Download className="h-5 w-5" aria-hidden />}
          >
            Download the agent
          </CtaLink>
        </div>
        <TrustStrip />
      </div>
    </section>
  );
}

const TRUST_BADGES: ReadonlyArray<{ icon: LucideIcon; label: string }> = [
  { icon: Shield, label: "Free desktop" },
  { icon: Cloud, label: "Cross-device cloud" },
  { icon: Tv, label: "OBS overlay ready" },
  { icon: CheckCircle2, label: "GDPR" },
];

function TrustStrip() {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-4 text-text-muted">
      {TRUST_BADGES.map(({ icon: Icon, label }) => (
        <li key={label} className="flex items-center gap-1.5 text-caption">
          <Icon className="h-4 w-4 text-accent-cyan" aria-hidden />
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

/* =============================================================== */
/* PILLARS                                                          */
/* =============================================================== */

interface Pillar {
  icon: LucideIcon;
  title: string;
  body: string;
}

const PILLARS: ReadonlyArray<Pillar> = [
  {
    icon: Wand2,
    title: "Auto Replay Classification",
    body: "Parse every game in seconds, no tagging.",
  },
  {
    icon: Fingerprint,
    title: "Opponent Intel DNA",
    body: "Persistent dossiers that survive name changes.",
  },
  {
    icon: BarChart3,
    title: "Build Recognizer",
    body: "Per-opener W-L with map and MMR breakdowns.",
  },
  {
    icon: Tv,
    title: "Live OBS Overlay",
    body: "15 broadcast-ready widgets, per-widget URLs.",
  },
  {
    icon: Brain,
    title: "ML Build Prediction",
    body: "Predict opponent strategy from early scout cues.",
  },
  {
    icon: Map,
    title: "Map Intel & Veto Planning",
    body: "Per-map win rates and timing libraries.",
  },
  {
    icon: Library,
    title: "Custom Build Library",
    body: "Sync your openers, browse the community pool.",
  },
  {
    icon: Mic2,
    title: "Voice Readout",
    body: "Optional in-ear scouting card before each game.",
  },
];

function PillarsSection() {
  return (
    <Section
      title="Eight pillars, one workflow"
      description="Every cloud feature you'll use, all wired into the same data pipeline."
      className="mx-auto max-w-6xl"
    >
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PILLARS.map((p) => (
          <PillarCard key={p.title} {...p} />
        ))}
      </ul>
    </Section>
  );
}

function PillarCard({ icon: Icon, title, body }: Pillar) {
  return (
    <li className="h-full">
      <Card variant="feature" padded={false} className="h-full">
        <div className="flex h-full flex-col gap-3 p-5">
          <div
            aria-hidden
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
          >
            <Icon className="h-5 w-5" />
          </div>
          <h3 className="text-h4 font-semibold text-text">{title}</h3>
          <p className="text-body text-text-muted">{body}</p>
        </div>
      </Card>
    </li>
  );
}

/* =============================================================== */
/* SHOWCASE                                                         */
/* =============================================================== */

interface ShowcaseItem {
  route: string;
  feature: string;
  icon: LucideIcon;
  title: string;
  body: string;
}

const SHOWCASE_ITEMS: ReadonlyArray<ShowcaseItem> = [
  {
    route: "sc2tools.app/app",
    feature: "Dashboard",
    icon: LayoutDashboard,
    title: "Your KPI room — between every game",
    body: "Total games, by-matchup bars, recent results, and MMR delta — all under one filter-aware lens that persists across every page.",
  },
  {
    route: "sc2tools.app/app/opponents",
    feature: "Opponent DNA",
    icon: Fingerprint,
    title: "Opponent dossiers that survive name changes",
    body: "Click any opponent and see every game, their build tendencies, predicted strategies, and median timings — keyed to a stable Pulse ID, not an in-replay name.",
  },
  {
    route: "sc2tools.app/streaming",
    feature: "Live Overlay",
    icon: Tv,
    title: "Stream-ready in one Browser Source",
    body: "Pop your hosted overlay URL into OBS. Pre-game scouting card, live W-L, post-game build reveal, streak splashes — all from one event bus.",
  },
  {
    route: "sc2tools.app/builds",
    feature: "Build classifier",
    icon: Wand2,
    title: "Tunable classifier, syncable library",
    body: "Auto-classified openers with per-build W-L, last-played, and a custom library you sync between machines and share with the community.",
  },
];

function ShowcaseSection() {
  return (
    <section className="mx-auto max-w-6xl space-y-12">
      <header className="mx-auto max-w-3xl text-center">
        <p className="text-caption font-semibold uppercase tracking-wider text-accent-cyan">
          Live preview
        </p>
        <h2 className="mt-2 text-h2 font-semibold md:text-h1">
          See it before you sign up
        </h2>
        <p className="mt-3 text-body-lg text-text-muted">
          Four surfaces. One data pipeline. No tagging required.
        </p>
      </header>
      <div className="space-y-12 md:space-y-20">
        {SHOWCASE_ITEMS.map((item, i) => (
          <ShowcaseRow key={item.feature} index={i} {...item} />
        ))}
      </div>
    </section>
  );
}

function ShowcaseRow({
  index,
  route,
  feature,
  icon,
  title,
  body,
}: ShowcaseItem & { index: number }) {
  const reverse = index % 2 === 1;
  return (
    <div
      className={[
        "flex flex-col gap-6 md:items-center md:gap-10",
        reverse ? "md:flex-row-reverse" : "md:flex-row",
      ].join(" ")}
    >
      <div className="space-y-3 md:max-w-md md:flex-1">
        <Badge
          variant="cyan"
          iconLeft={<Sparkles className="h-3.5 w-3.5" aria-hidden />}
        >
          {feature}
        </Badge>
        <h3 className="text-h2 font-semibold text-text">{title}</h3>
        <p className="text-body-lg text-text-muted">{body}</p>
      </div>
      <div className="md:flex-1">
        <DeviceFrame variant="browser" title={route} glow>
          <ScreenshotPlaceholder icon={icon} feature={feature} />
        </DeviceFrame>
      </div>
    </div>
  );
}

function ScreenshotPlaceholder({
  icon: Icon,
  feature,
}: {
  icon: LucideIcon;
  feature: string;
}) {
  return (
    <div
      data-placeholder="true"
      className="relative flex aspect-[16/9] flex-col items-center justify-center gap-3 overflow-hidden bg-bg"
    >
      <GlowHalo color="cyan" position="center" size={70} opacity={0.85} />
      <div
        aria-hidden
        className="relative inline-flex h-14 w-14 items-center justify-center rounded-xl border border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
      >
        <Icon className="h-7 w-7" />
      </div>
      <div className="relative space-y-0.5 text-center">
        <div className="text-body font-semibold text-text">
          Screenshot · {feature}
        </div>
        <div className="text-caption text-text-dim">Coming with v1.0</div>
      </div>
    </div>
  );
}

/* =============================================================== */
/* HOW IT WORKS                                                     */
/* =============================================================== */

interface Step {
  num: string;
  title: string;
  body: string;
}

const STEPS: ReadonlyArray<Step> = [
  {
    num: "01",
    title: "Install the agent",
    body: "Download the 15 MB binary and pair it with your account in 90 seconds.",
  },
  {
    num: "02",
    title: "Play normally",
    body: "Every replay you finish parses and uploads in the background. No tagging, no manual import.",
  },
  {
    num: "03",
    title: "Light it up",
    body: "Your dashboard updates between games. Drop your overlay URL into OBS for stream-day reveal.",
  },
];

function HowItWorksSection() {
  return (
    <Section
      title="How it works"
      description="Three steps. Stays out of your way after that."
      className="mx-auto max-w-6xl"
    >
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-[16.67%] top-9 hidden h-px bg-gradient-to-r from-transparent via-accent-cyan/50 to-transparent md:block"
        />
        <ol className="relative grid gap-6 md:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.num}>
              <Card padded={false} className="h-full">
                <div className="space-y-3 p-5">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-accent-cyan/40 bg-bg-surface font-mono text-caption font-semibold text-accent-cyan">
                    {step.num}
                  </span>
                  <h3 className="text-h4 font-semibold text-text">
                    {step.title}
                  </h3>
                  <p className="text-body text-text-muted">{step.body}</p>
                </div>
              </Card>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  );
}

/* =============================================================== */
/* SOCIAL PROOF                                                     */
/* =============================================================== */

function SocialProofSection() {
  return (
    <section className="mx-auto max-w-3xl text-center">
      <p className="text-caption font-semibold uppercase tracking-wider text-accent-cyan">
        Built in the open
      </p>
      <p className="mt-3 text-h2 font-semibold text-text md:text-h1">
        Built by ladder players,
        <br className="hidden sm:inline" /> for ladder players.
      </p>
      <p className="mx-auto mt-4 max-w-2xl text-body-lg text-text-muted">
        Every classifier rule, every overlay, every UI decision came from
        someone trying to win their next game. Bug reports and feature
        requests go straight into the build.
      </p>
    </section>
  );
}

/* =============================================================== */
/* FINAL CTA                                                        */
/* =============================================================== */

function FinalCtaSection() {
  return (
    <section className="relative">
      <div className="gradient-backdrop relative mx-auto max-w-5xl overflow-hidden rounded-2xl border border-accent-cyan/30 px-6 py-12 shadow-halo-cyan md:px-12 md:py-16">
        <GlowHalo color="mixed" position="center" size={90} />
        <div className="relative mx-auto max-w-3xl space-y-5 text-center">
          <h2 className="text-h1 font-bold tracking-tight text-text md:text-display-lg">
            Stop guessing.{" "}
            <span className="text-accent-cyan">Start knowing.</span>
          </h2>
          <p className="text-body-lg text-text-muted">
            Free to start. No credit card. Your replays stay on your machine;
            only the parsed metadata syncs.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <CtaLink
              href="/sign-up"
              iconRight={<ArrowRight className="h-5 w-5" aria-hidden />}
            >
              Create your account
            </CtaLink>
            <CtaLink
              href="/community"
              variant="secondary"
              iconLeft={<BookOpen className="h-5 w-5" aria-hidden />}
            >
              Read the docs
            </CtaLink>
          </div>
        </div>
      </div>
    </section>
  );
}

/* =============================================================== */
/* CTA LINK — landing-page-only Button-styled <Link>                */
/* =============================================================== */

interface CtaLinkProps {
  href: string;
  variant?: "primary" | "secondary";
  size?: "md" | "lg";
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  children: ReactNode;
  className?: string;
}

function CtaLink({
  href,
  variant = "primary",
  size = "lg",
  iconLeft,
  iconRight,
  children,
  className = "",
}: CtaLinkProps) {
  const variantClass =
    variant === "primary"
      ? "bg-accent text-white hover:bg-accent-hover"
      : "bg-bg-elevated text-text border border-border hover:bg-bg-subtle hover:border-border-strong";
  const sizeClass =
    size === "lg"
      ? "h-12 px-5 text-body-lg gap-2.5"
      : "h-10 px-4 text-body gap-2";
  return (
    <Link
      href={href}
      className={[
        "inline-flex min-w-[44px] items-center justify-center rounded-lg font-semibold",
        "transition-colors duration-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        variantClass,
        sizeClass,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {iconLeft ? <span className="flex-shrink-0">{iconLeft}</span> : null}
      {children}
      {iconRight ? <span className="flex-shrink-0">{iconRight}</span> : null}
    </Link>
  );
}

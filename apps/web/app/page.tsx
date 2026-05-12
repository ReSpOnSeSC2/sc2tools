import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Cloud,
  Download,
  Gamepad2,
  Heart,
  Library,
  Map,
  Mic2,
  Shield,
  Sparkles,
  Swords,
  Tv,
  Wand2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Banner } from "@/components/Banner";
import {
  Badge,
  Card,
  GlowHalo,
  Section,
} from "@/components/ui";
import {
  HeroCarousel,
  type HeroCarouselSlide,
} from "@/components/landing/HeroCarousel";
import { ReplayDemo } from "@/components/landing/ReplayDemo";

/* =============================================================== */
/* PAGE                                                             */
/* =============================================================== */

export default function LandingPage() {
  return (
    <div className="space-y-24 md:space-y-32">
      <CarouselSection />
      <SocialProofSection />
      <ReplayDemo />
      <AgentDownloadSection />
      <PillarsSection />
      <HowItWorksSection />
      <ArcadeSection />
      <HeroHeadlineSection />
      <DonateBanner />
      <FinalCtaSection />
    </div>
  );
}

/* =============================================================== */
/* CAROUSEL — top-of-page product peek                              */
/* =============================================================== */

function CarouselSection() {
  const slides: ReadonlyArray<HeroCarouselSlide> = [
    {
      id: "hero",
      label: "Your opponent's build, before they build it",
      content: <HeroBannerSlide />,
    },
    ...HERO_PEEK_SLIDES.map((peek) => ({
      id: peek.id,
      label: peek.eyebrow,
      content: <HeroPeekSlide {...peek} />,
    })),
  ];
  return (
    <section className="relative pt-2">
      <HeroCarousel
        slides={slides}
        ariaLabel="SC2 Tools landing carousel"
      />
    </section>
  );
}

/* =============================================================== */
/* AGENT DOWNLOAD — the install / sign-up CTA cluster               */
/* =============================================================== */

function AgentDownloadSection() {
  return (
    <section className="relative">
      <div className="relative mx-auto max-w-3xl space-y-4 text-center">
        <p className="mx-auto max-w-2xl text-body-lg text-text-muted">
          Sign in, install a 219&nbsp;MB agent, and every replay you finish
          surfaces an opponent dossier, build classifier, and live OBS
          overlay — across every device.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
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
        <div className="flex justify-center">
          <TrustStrip />
        </div>
      </div>
    </section>
  );
}

/* =============================================================== */
/* HERO HEADLINE — the brand promise, no carousel, no CTAs          */
/* =============================================================== */

function HeroHeadlineSection() {
  return (
    <section className="relative">
      <div className="relative mx-auto max-w-3xl text-center">
        <h1 className="text-[40px] font-bold leading-[44px] tracking-tight md:text-display-lg lg:text-display-xl">
          Your opponent&apos;s build,
          <br />
          <span className="text-accent-cyan">before they build it.</span>
        </h1>
      </div>
    </section>
  );
}

/* ----- Hero carousel slide bodies -------------------------------- */

function HeroBannerSlide() {
  return (
    <div className="relative">
      <Banner variant="hero" />
    </div>
  );
}

interface HeroPeek {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  imageSrc: string;
  imageAlt: string;
}

const HERO_PEEK_SLIDES: ReadonlyArray<HeroPeek> = [
  {
    id: "peek-dossier",
    eyebrow: "See it before you sign up",
    title: "Opponent dossier — auto-built",
    body: "Race, MMR, build tendencies, recent matchup history — surfaced the moment a replay finishes parsing.",
    imageSrc: "/landing/opponent-dna.png",
    imageAlt:
      "Opponent profile page in SC2 Tools showing matchup record, build tendencies, and median key timings",
  },
  {
    id: "peek-overlay-live",
    eyebrow: "See it before you sign up",
    title: "Live OBS overlay — copy & paste",
    body: "15 broadcast-ready widgets behind one URL. Drop it into a Browser Source and you're streaming.",
    imageSrc: "/landing/overlay-live.png",
    imageAlt:
      "StarCraft II gameplay with the SC2 Tools live OBS overlay running — opponent identity card, session record, and rematch flag",
  },
  {
    id: "peek-overlay-rematch",
    eyebrow: "See it before you sign up",
    title: "Familiar-opponent flags, on stream",
    body: "Run-it-back? The overlay calls out repeats with last-result, head-to-head record, and the games that got you there.",
    imageSrc: "/landing/overlay-rematch.png",
    imageAlt:
      "Stream overlay rematch widget — opponent name, MMR, FAMILIAR / Last Defeat tag, and a list of recent games",
  },
  {
    id: "peek-builds",
    eyebrow: "See it before you sign up",
    title: "Build classifier — no tagging",
    body: "Every replay auto-classified into your build library. Win-rate per opener, per matchup, per map.",
    imageSrc: "/landing/builds.png",
    imageAlt:
      "Custom Builds page in SC2 Tools showing per-build wins, losses, win rate, and trend sparklines",
  },
  {
    id: "peek-build-editor",
    eyebrow: "See it before you sign up",
    title: "Save any replay as a custom build",
    body: "Open a game, click ‘Save as new build’, promote starred events into rules — your library reclassifies in place.",
    imageSrc: "/landing/build-editor.png",
    imageAlt:
      "Save-as-new-build editor with the source replay timeline on the left and one-click rule promotion buttons",
  },
];

function HeroPeekSlide({
  eyebrow,
  title,
  body,
  imageSrc,
  imageAlt,
}: HeroPeek) {
  return (
    <div className="relative grid min-h-[260px] items-center gap-6 px-6 py-8 sm:min-h-[320px] sm:px-10 sm:py-12 md:min-h-[420px] md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] md:gap-10 md:py-14">
      <GlowHalo color="cyan" position="center" size={60} opacity={0.55} />
      <div className="relative space-y-3 text-center md:text-left">
        <p className="text-caption font-semibold uppercase tracking-wider text-accent-cyan">
          {eyebrow}
        </p>
        <h2 className="text-h2 font-semibold text-text md:text-h1">{title}</h2>
        <p className="text-body-lg text-text-muted">{body}</p>
      </div>
      <div className="relative">
        <div className="overflow-hidden rounded-xl border border-border bg-bg-elevated/40 shadow-halo-cyan">
          <Image
            src={imageSrc}
            alt={imageAlt}
            width={1600}
            height={900}
            sizes="(min-width: 1024px) 60vw, 100vw"
            className="block h-auto w-full"
          />
        </div>
      </div>
    </div>
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

interface PositionedPillar extends Pillar {
  /** Tailwind grid placement classes for the lg+ triangle layout. */
  placement: string;
}

/**
 * Pillars laid out as a 4 → 2 → 1 triangle on lg+, narrowing toward the
 * apex. Apex is the marquee feature (Live OBS Overlay); the middle band
 * carries the in-game analysis layer; the four-card base is the data
 * pipeline that feeds everything above it. On smaller viewports the
 * placement classes are ignored and pillars flow as a regular 2-col grid
 * (or stack on mobile), so the order below is also the read order.
 *
 * Apex sits at DOM top so the section reads top→bottom; the visual
 * "build up from the foundation" cue comes from the widening triangle.
 */
const PILLARS: ReadonlyArray<PositionedPillar> = [
  // Apex — marquee feature
  {
    icon: Tv,
    title: "Live OBS Overlay",
    body: "15 broadcast-ready widgets, per-widget URLs. Drop one URL into Browser Source and you're streaming.",
    placement: "lg:col-span-2 lg:col-start-4",
  },
  // Middle band — analysis & in-game support
  {
    icon: Swords,
    title: "Strategy Detection",
    body: "Per-matchup playbook with rule-based opener identification across 100+ builds.",
    placement: "lg:col-span-2 lg:col-start-3",
  },
  {
    icon: Mic2,
    title: "Voice Readout",
    body: "Optional in-ear scouting card before each game.",
    placement: "lg:col-span-2 lg:col-start-5",
  },
  // Base — the data pipeline
  {
    icon: Wand2,
    title: "Auto Replay Classification",
    body: "Parse every game in seconds, no tagging.",
    placement: "lg:col-span-2 lg:col-start-1",
  },
  {
    icon: BarChart3,
    title: "Build Recognizer",
    body: "Per-opener W-L with map and MMR breakdowns.",
    placement: "lg:col-span-2 lg:col-start-3",
  },
  {
    icon: Map,
    title: "Map Intel & Veto Planning",
    body: "Per-map win rates and timing libraries.",
    placement: "lg:col-span-2 lg:col-start-5",
  },
  {
    icon: Library,
    title: "Custom Build Library",
    body: "Sync your openers, browse the community pool.",
    placement: "lg:col-span-2 lg:col-start-7",
  },
];

function PillarsSection() {
  return (
    <Section
      title="Seven pillars, one workflow"
      description="Every cloud feature you'll use, all wired into the same data pipeline."
      className="mx-auto max-w-6xl"
    >
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-8">
        {PILLARS.map((p) => (
          <PillarCard key={p.title} {...p} />
        ))}
      </ul>
    </Section>
  );
}

function PillarCard({ icon: Icon, title, body, placement }: PositionedPillar) {
  return (
    <li className={["h-full", placement].filter(Boolean).join(" ")}>
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
    body: "Download the 219 MB installer and pair it with your account in 90 seconds.",
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
/* ARCADE — quizzes/games generated from the user's real replays    */
/* =============================================================== */

interface ArcadeTile {
  /** Path under /public for the mode's PNG icon. */
  iconSrc: string;
  title: string;
  body: string;
}

const ARCADE_TILES: ReadonlyArray<ArcadeTile> = [
  {
    iconSrc: "/arcade/icons/buildle.png",
    title: "Buildle",
    body: "Daily case file. One real game, one hidden fact, one shot to crack it.",
  },
  {
    iconSrc: "/arcade/icons/closers-eye.png",
    title: "Closer's Eye",
    body: "Which of your builds closes wins the fastest? Mean win-length, blind.",
  },
  {
    iconSrc: "/arcade/icons/two-truths-lie.png",
    title: "Two Truths & a Lie",
    body: "Two real facts about your play, one fake. Spot the lie.",
  },
  {
    iconSrc: "/arcade/icons/bingo-ladder.png",
    title: "Bingo: Ladder Edition",
    body: "A 5×5 of forward objectives. Your next-7-day games tick the cells.",
  },
  {
    iconSrc: "/arcade/icons/stock-market.png",
    title: "Stock Market",
    body: "Lock in a build portfolio. Weekly P&L feeds the leaderboard.",
  },
];

function ArcadeSection() {
  return (
    <section className="relative mx-auto max-w-6xl space-y-6">
      <header className="space-y-3 text-center">
        <Badge
          variant="cyan"
          iconLeft={<Sparkles className="h-3.5 w-3.5" aria-hidden />}
        >
          New · Arcade
        </Badge>
        <h2 className="text-h1 font-bold tracking-tight text-text md:text-display-lg">
          Your ladder data,{" "}
          <span className="text-accent-cyan">playable</span>
        </h2>
        <p className="mx-auto max-w-2xl text-body-lg text-text-muted">
          Thirteen modes — quizzes, games, weekly bingo — all generated from
          your real replays. Daily drop, XP, shareable score cards.
        </p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ARCADE_TILES.map((tile) => (
          <ArcadeTileCard key={tile.title} {...tile} />
        ))}
        <ArcadeMoreCard />
      </ul>
      <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
        <CtaLink
          href="/sign-up"
          iconLeft={<Gamepad2 className="h-5 w-5" aria-hidden />}
          iconRight={<ArrowRight className="h-5 w-5" aria-hidden />}
        >
          Sign in to play
        </CtaLink>
      </div>
    </section>
  );
}

function ArcadeTileCard({ iconSrc, title, body }: ArcadeTile) {
  return (
    <li className="h-full">
      <Card variant="feature" padded={false} className="h-full">
        <div className="flex h-full flex-col gap-3 p-5">
          <div
            aria-hidden
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-accent-cyan/30 bg-accent-cyan/10"
          >
            <Image
              src={iconSrc}
              alt=""
              width={28}
              height={28}
              className="h-7 w-7"
              unoptimized
            />
          </div>
          <h3 className="text-h4 font-semibold text-text">{title}</h3>
          <p className="text-body text-text-muted">{body}</p>
        </div>
      </Card>
    </li>
  );
}

function ArcadeMoreCard() {
  return (
    <li className="h-full">
      <Card variant="feature" padded={false} className="h-full">
        <div className="flex h-full flex-col gap-3 p-5">
          <div
            aria-hidden
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
          >
            <Gamepad2 className="h-5 w-5" />
          </div>
          <h3 className="text-h4 font-semibold text-text">+8 more modes</h3>
          <p className="text-body text-text-muted">
            Streaks, macro memory, rivalries, comebacks, build cards… Quick
            Play any of them, or chase the Daily Drop.
          </p>
        </div>
      </Card>
    </li>
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
/* DONATE BANNER                                                    */
/* =============================================================== */

function DonateBanner() {
  return (
    <section className="mx-auto max-w-5xl">
      <Card padded={false}>
        <div className="grid items-center gap-6 p-6 md:grid-cols-[auto_minmax(0,1fr)_auto] md:gap-8 md:p-8">
          <span
            aria-hidden
            className="inline-flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl border border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan shadow-halo-cyan"
          >
            <Heart className="h-7 w-7" />
          </span>
          <div className="space-y-1">
            <Badge variant="cyan">Donation-supported</Badge>
            <h2 className="text-h3 font-semibold text-text md:text-h2">
              Free now, free forever — donations keep the servers up.
            </h2>
            <p className="text-body text-text-muted">
              One paid Render service, a MongoDB Atlas M10 cluster, and the
              sc2tools.com domain run the cloud. If SC2 Tools is helping your
              ladder grind, a one-time tip helps cover the bill.
            </p>
          </div>
          <Link
            href="/donate"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-accent px-5 text-body-lg font-semibold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg md:self-center"
          >
            See how to chip in
            <ArrowRight className="h-5 w-5" aria-hidden />
          </Link>
        </div>
      </Card>
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
              iconLeft={<Library className="h-5 w-5" aria-hidden />}
            >
              Browse community builds
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

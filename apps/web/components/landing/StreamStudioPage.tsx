/**
 * /stream-studio — the dedicated landing page for SC2 Tools' OBS overlays.
 *
 * "sc2 overlay" / "starcraft 2 overlay" are the searches the site already
 * ranks best for, but until now only the homepage answered them. This page
 * gives those searches a specific destination: what shows on stream, how
 * to set it up, and the common questions.
 *
 * Every claim mirrors the product: widget names and descriptions follow
 * the Settings → Overlay registry, counts come from PRODUCT_FACTS (kept
 * honest by lib/__tests__/productFacts.test.ts), and the setup steps
 * follow the real Settings flow.
 */
import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Download, MessagesSquare, MonitorPlay, Swords, Trophy } from "lucide-react";
import { PRODUCT_FACTS } from "@/lib/productFacts";
import { OVERLAY_CREDIT_TEXT } from "@/lib/overlayCredit";
import { StreamManagerShowcase } from "@/components/landing/StreamManagerShowcase";

interface FeatureGroup {
  title: string;
  icon: typeof Swords;
  items: ReadonlyArray<{ name: string; body: string }>;
}

const FEATURE_GROUPS: ReadonlyArray<FeatureGroup> = [
  {
    title: "Before and during the game",
    icon: Swords,
    items: [
      { name: "Opponent identity", body: "Race, MMR and your head-to-head record, on screen while the game loads." },
      { name: "Scouting tells", body: "The strategies this opponent is likely to open with, and when to look for them." },
      { name: "Favourite opening and best answer", body: "Their most-shown opening and your best counter to it." },
      { name: "Cheese alert", body: "A warning when the opponent's history points to an early all-in." },
      { name: "Rematch and rival", body: "Flags opponents you've played recently or keep meeting." },
      { name: "Rank, meta snapshot and top builds", body: "League, tier and MMR, the openings this matchup sees most, and your best builds in it." },
    ],
  },
  {
    title: "After the game",
    icon: Trophy,
    items: [
      { name: "Match result, MMR change and streak", body: "Victory or defeat, the points it cost or earned, and any run of three or more." },
      { name: "Post-game build", body: "A build summary for the game just played." },
      { name: "Broadcast lower third", body: "An esports-style bar with the result, MMR change, head-to-head and session record." },
      { name: "Session record", body: "Today's wins, losses and MMR, always on screen." },
      { name: "Session recap", body: "A win-loss and net-MMR card you fire on demand from the Stream Dock." },
    ],
  },
  {
    title: "Chat and community",
    icon: MessagesSquare,
    items: [
      { name: "Multi-platform chat", body: `Twitch, Kick, YouTube and TikTok chat merged into one feed (${PRODUCT_FACTS.chatPlatforms} platforms).` },
      { name: "Event alerts", body: "Subs, raids, gifts and superchats as an alert toaster." },
      { name: "Polls and highlights", body: "Viewer polls with !1 / !2 voting, and pinned chat messages." },
      { name: "Crystal Ball predictions", body: "Chat calls !win or !loss before each game and climbs a leaderboard." },
      { name: "Supporter wall", body: "Cross-platform loyalty ranks, from Probe to Mothership." },
      { name: "Goals, ticker, timer and clip flags", body: "Goal bars, a scrolling stats line, a countdown, and a CLIP THAT! pulse when chat spikes." },
    ],
  },
  {
    title: "Scenes and practice",
    icon: MonitorPlay,
    items: [
      { name: "Starting Soon, BRB and Intermission", body: "Full-screen scenes with a countdown, switched from the Stream Dock." },
      { name: "Between Games scene", body: "The desktop agent can build it and switch to it automatically when a game ends." },
      { name: "Virtual sets", body: `${PRODUCT_FACTS.virtualSets} broadcast backdrops, ready at 1080p and 4K.` },
      { name: "Ghost Build coach", body: "Your chosen build's next steps, synced to the live game." },
      { name: "Build randomizer", body: "Spins a weighted random build for each new matchup." },
      { name: "Voice readout", body: "The scouting report read aloud as the game loads." },
    ],
  },
];

const SETUP_STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Create a free account and install the agent",
    body: "The desktop agent runs on the Windows PC you play on. It reads StarCraft II's live game data and each replay as you finish it.",
  },
  {
    title: "Copy your overlay URL",
    body: "In Settings → Overlay, copy the All-in-one URL, or one URL per widget if you'd rather place each one yourself.",
  },
  {
    title: "Add it to OBS",
    body: "In OBS Studio or Streamlabs, add a Browser Source, paste the URL and size it to your canvas.",
  },
  {
    title: "Test, then queue up",
    body: "Click Test all to preview every widget on your scene. From then on the overlay updates by itself.",
  },
];

const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "Is it free?",
    a: "Yes. Stream Studio, the overlays and the desktop agent are free, with no card required.",
  },
  {
    q: "Does it work with Streamlabs?",
    a: "Yes. Every overlay is a web page you add as a Browser Source, which works the same in OBS Studio and Streamlabs Desktop.",
  },
  {
    q: "Do I need the desktop agent?",
    a: "For the live overlays, yes: a web page can't read StarCraft II's game data on your PC, so the agent sends it. Without the agent you can still analyze replays in your browser.",
  },
  {
    q: "Can I change how it looks?",
    a: "Yes. Settings → Overlay lets you pick the accent colour, size, opacity, corners, font and frame style, and toggle each widget on or off.",
  },
  {
    q: `Can I hide the “${OVERLAY_CREDIT_TEXT}” credit?`,
    a: "Yes. Switch it off in Settings → Overlay, then copy your URLs into OBS again.",
  },
];

function PageCta({ href, primary, children }: { href: string; primary?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={[
        "inline-flex min-h-12 min-w-[44px] items-center justify-center gap-2.5 rounded-md px-5 py-2 text-center text-body-lg font-semibold",
        "transition-colors duration-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        primary ? "bg-accent text-white hover:brightness-90" : "border-2 border-line bg-bg-elevated text-text hover:bg-bg-subtle",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}

function SectionTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="max-w-3xl">
      <p className="kicker">{kicker}</p>
      <h2 className="mt-3 font-serif text-[30px] font-semibold leading-tight tracking-[-0.01em] text-text md:text-[38px]">
        {title}
      </h2>
    </div>
  );
}

function Hero() {
  return (
    <header className="grid items-center gap-x-10 gap-y-8 pt-4 md:pt-10 lg:grid-cols-12">
      <div className="min-w-0 lg:col-span-5">
        <h1>
          <span className="kicker block">Stream Studio · free for StarCraft II streamers</span>
          <span className="mt-5 block font-serif text-[40px] font-semibold leading-[1.04] tracking-[-0.01em] text-text md:text-[56px]">
            StarCraft II overlays for OBS
          </span>
        </h1>
        <p className="mt-6 max-w-prose text-body-lg text-text-muted">
          Add one Browser Source and your stream shows who you&apos;re facing before the game loads, your record
          against them, and how the match went, all read automatically from your games.{" "}
          {PRODUCT_FACTS.overlayWidgets} copy-and-paste widgets, merged chat and full-screen scenes.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <PageCta href="/download" primary>
            <Download className="h-5 w-5" aria-hidden />
            Download the free agent
          </PageCta>
          <PageCta href="/sign-up">Create a free account</PageCta>
        </div>
        <p className="mt-4 text-caption text-text-dim">Free forever · OBS Studio and Streamlabs · The agent runs on Windows</p>
      </div>
      <figure className="min-w-0 lg:col-span-7">
        <Image
          src="/landing/overlay-live.png"
          alt="A StarCraft II stream with the SC2 Tools overlay: the opponent's name, race and MMR at the top, and the session record in the corner"
          width={2000}
          height={1124}
          sizes="(min-width: 1024px) 58vw, 100vw"
          priority
          className="h-auto w-full rounded-md border-2 border-line shadow-hard"
        />
      </figure>
    </header>
  );
}

function Features() {
  return (
    <section aria-labelledby="stream-studio-features" className="pt-20 md:pt-28">
      <div id="stream-studio-features">
        <SectionTitle kicker="On your stream" title="What your viewers see" />
      </div>
      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {FEATURE_GROUPS.map(({ title, icon: Icon, items }) => (
          <article key={title} className="min-w-0 rounded-md border-2 border-line bg-bg-surface p-5 shadow-hard sm:p-6">
            <h3 className="flex items-center gap-2 text-h3 font-semibold text-text">
              <Icon className="h-5 w-5 flex-shrink-0 text-accent" aria-hidden />
              {title}
            </h3>
            <ul className="mt-4 space-y-3">
              {items.map((item) => (
                <li key={item.name} className="text-body text-text-muted">
                  <strong className="font-semibold text-text">{item.name}.</strong> {item.body}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      <figure className="mt-10">
        <Image
          src="/landing/overlay-rematch.png"
          alt="The rematch card on stream: a familiar opponent, the last result against them, and the builds from recent games"
          width={2000}
          height={1114}
          sizes="(min-width: 1152px) 1152px, 100vw"
          className="h-auto w-full rounded-md border-2 border-line shadow-hard"
        />
        <figcaption className="mt-3 text-caption text-text-dim">
          Facing someone again? The rematch card shows how your last games against them went.
        </figcaption>
      </figure>
    </section>
  );
}

function Setup() {
  return (
    <section aria-labelledby="stream-studio-setup" className="pt-20 md:pt-28">
      <div id="stream-studio-setup">
        <SectionTitle kicker="Setup" title="On your stream in a few minutes" />
      </div>
      <ol className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {SETUP_STEPS.map((step, index) => (
          <li key={step.title} className="min-w-0 rounded-md border-2 border-line bg-bg-surface p-5 shadow-hard">
            <span className="font-serif text-[32px] font-semibold leading-none text-editorial" aria-hidden>
              {index + 1}
            </span>
            <h3 className="mt-3 text-body-lg font-semibold text-text">{step.title}</h3>
            <p className="mt-2 text-body text-text-muted">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Questions() {
  return (
    <section aria-labelledby="stream-studio-faq" className="pt-20 md:pt-28">
      <div id="stream-studio-faq">
        <SectionTitle kicker="Questions" title="Stream Studio FAQ" />
      </div>
      <div className="mt-8 grid gap-6 md:grid-cols-2">
        {FAQ.map(({ q, a }) => (
          <div key={q} className="min-w-0">
            <h3 className="text-body-lg font-semibold text-text">{q}</h3>
            <p className="mt-1 text-body text-text-muted">{a}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FinalCta({ tryEnabled }: { tryEnabled: boolean }) {
  return (
    <section className="mt-20 rounded-md border-2 border-line bg-bg-surface p-6 shadow-hard md:mt-28 md:p-10">
      <h2 className="font-serif text-[28px] font-semibold leading-tight text-text md:text-[36px]">
        Put your opponent on screen before the game starts.
      </h2>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <PageCta href="/download" primary>
          <Download className="h-5 w-5" aria-hidden />
          Download the free agent
        </PageCta>
        {tryEnabled ? (
          <Link
            href="/try"
            className="inline-flex min-h-[44px] items-center gap-2 font-semibold text-text-muted underline-offset-4 hover:text-text hover:underline"
          >
            Or analyze a replay in your browser first
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The /stream-studio page body.
 *
 * Example:
 *   <StreamStudioPage tryEnabled />
 */
export function StreamStudioPage({ tryEnabled }: { tryEnabled: boolean }) {
  return (
    <article className="mx-auto max-w-6xl">
      <Hero />
      <StreamManagerShowcase className="mt-16 md:mt-20" />
      <Features />
      <Setup />
      <Questions />
      <FinalCta tryEnabled={tryEnabled} />
    </article>
  );
}

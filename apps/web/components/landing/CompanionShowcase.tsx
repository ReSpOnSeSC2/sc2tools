import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Download, SlidersHorizontal, Star } from "lucide-react";

const PANELS = [
  {
    image: "/landing/companion-selectors.png",
    alt: "Native Companion build selectors with current matchup and independent check-in controls, using sample data",
    title: "Choose a plan. Or let your pool choose.",
    text: "Pick builds before and after a game, correct your opponent's build, or draw from your shared randomizer pool. Each match keeps one saved pick.",
  },
  {
    image: "/landing/companion-ghost.png",
    alt: "Native Build Order Ghost with replay sources, player preview and matchup target, using sample data",
    title: "Practice from the replay you trust.",
    text: "Open a local replay or choose from your synced games. Preview either player's build order, assign it to a matchup, and follow its timing steps beside the game.",
  },
] as const;

export function CompanionShowcase() {
  return (
    <section id="desktop-companion" aria-labelledby="companion-showcase-title" className="scroll-mt-24 border-t border-line py-16 md:py-24">
      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-end">
        <div className="min-w-0">
          <p className="kicker">Windows desktop Companion preview</p>
          <h2 id="companion-showcase-title" className="mt-4 max-w-2xl font-serif text-4xl font-semibold leading-tight text-text md:text-5xl">
            Your ladder desk, beside the game.
          </h2>
          <p className="mt-5 max-w-prose text-body-lg text-text-muted">
            Browse a purple two-panel scouting console: opponent portrait on the left, replay build chains on the right. Compare the openings and tech steps from your previous games, then pin just the panels you want while you play.
          </p>
        </div>
        <div className="min-w-0">
          <div className="flex items-start gap-3 text-text-muted">
            <SlidersHorizontal className="mt-1 h-5 w-5 shrink-0 text-accent-cyan" aria-hidden />
            <p className="text-body">One game assistance switch, plus separate controls for scouting, opponent panels, spoken reports, build selectors, randomizer and Ghost. Turn them on or off whenever you need.</p>
          </div>
          <p className="mt-4 text-caption text-text-muted">Runs without OBS. Stream overlays remain an optional way to show selected features to viewers.</p>
          <p className="mt-3 text-caption text-text-muted">Home and Back keep browsing simple. Separate opponent and game arrows retain your place; Assistance and Agent menus keep the controls nearby.</p>
          <p className="mt-3 text-caption text-text-muted">Opt in to native Windows system-voice reports for fresh human 1v1 games. Voice, master and mode switches work together. OBS voice settings stay separate; keep only one scouting voice enabled to avoid duplicate audio.</p>
          <p className="mt-3 text-caption text-text-muted">Save your own Ladder, Customs, Teams, Practice and Review presets. Customize each feature locally, with an optional Ctrl+Shift+F10 master shortcut. Team-game guidance is not supported.</p>
          <p className="mt-4 rounded-sm border border-warning/40 bg-bg-surface p-3 text-caption text-text-muted">Companion 0.21.1 is a preview, not included in the current stable download. A signed public release is pending; unsigned verification builds are separate test artifacts.</p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link href="/download" className="inline-flex min-h-11 items-center gap-2 rounded-sm bg-accent-cyan px-4 py-2 text-caption font-bold text-[#071b22] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg">
              <Download className="h-4 w-4" aria-hidden />Download current stable agent
            </Link>
            <Link href="/help/desktop-companion" className="inline-flex min-h-11 items-center gap-2 text-caption font-semibold text-text underline-offset-4 hover:underline">
              Explore Companion<ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </div>
      <div className="mt-9 grid min-w-0 gap-6 rounded-md border border-border bg-bg-surface p-4 sm:p-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-center">
        <figure className="mx-auto w-full min-w-0 max-w-[360px] lg:mx-0">
          <Image src="/landing/companion-compact.png" alt="Compact Companion showing a sample opponent's name, race and MMR, your record and your win rate against that opponent, plus an expand button" width={360} height={240} sizes="(max-width: 400px) 100vw, 360px" className="h-auto w-full rounded-md" />
          <figcaption className="mt-2 text-micro text-text-dim">Compact layout · actual interface with sample data.</figcaption>
        </figure>
        <div className="min-w-0">
          <h3 className="font-serif text-2xl font-semibold text-text">Choose how much you see.</h3>
          <ul className="mt-4 grid gap-3 text-caption text-text-muted sm:grid-cols-2">
            <li><strong className="text-text">Compact</strong> — name, race and MMR, plus your W–L and win percentage against this opponent. A small expand button opens Standard.</li>
            <li><strong className="text-text">Standard</strong> — both players&apos; opening icon chains with key replay timings.</li>
            <li><strong className="text-text">Detailed</strong> — more tech steps and upgrade completion chains.</li>
            <li><strong className="text-text">Full workspace</strong> — full openings, notes, history, filters and replay tools.</li>
          </ul>
        </div>
      </div>
      <figure className="mt-9 min-w-0">
        <div className="overflow-hidden rounded-md border border-border-strong bg-[#10131f] shadow-hard">
          <Image src="/landing/companion-workspace.png" alt="SC2 Tools purple Companion console with opponent portrait, Home and Back navigation and both players' replay timelines, using sample data" width={1440} height={1080} sizes="(max-width: 1280px) 100vw, 1200px" className="h-auto w-full" />
        </div>
        <figcaption className="mt-3 text-micro text-text-dim">Actual desktop interface · screenshots use sample data.</figcaption>
      </figure>
      <div className="mt-10 grid min-w-0 gap-8 md:grid-cols-2">
        {PANELS.map((panel) => (
          <div key={panel.image} className="min-w-0">
            <div className="overflow-hidden rounded-md border border-border-strong bg-[#10131f]">
              <Image src={panel.image} alt={panel.alt} width={1440} height={1080} sizes="(max-width: 767px) 100vw, 50vw" className="h-auto w-full" />
            </div>
            <h3 className="mt-4 font-serif text-2xl font-semibold text-text">{panel.title}</h3>
            <p className="mt-2 text-body text-text-muted">{panel.text}</p>
          </div>
        ))}
      </div>
      <div className="mt-8 flex items-start gap-3 border-t border-border pt-5 text-caption text-text-muted">
        <Star className="mt-0.5 h-4 w-4 shrink-0 text-editorial" aria-hidden />
        <p>Star a reference replay for each build from Builds or Opponents. Keep your own examples handy, or practice from an example an admin has explicitly published.</p>
      </div>
    </section>
  );
}

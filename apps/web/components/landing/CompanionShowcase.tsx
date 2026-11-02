import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Download, SlidersHorizontal, Star } from "lucide-react";
import { LinkButton } from "@/components/ui/Button";

const PANELS = [
  {
    image: "/landing/companion-selectors.png",
    width: 1440, height: 1080, caption: "",
    alt: "Native Companion build selectors with current matchup and independent check-in controls, using sample data",
    title: "Choose your opening before the game.",
    text: "Pick your plan in the native 1v1 build selector. Keep loading prompts and after-game check-ins independently enabled without opening an OBS source.",
  },
  {
    image: "/landing/companion-postgame.png",
    width: 1440, height: 1080, caption: "",
    alt: "Native Companion after-game check-in with your build and the opponent's strategy, using sample 1v1 data",
    title: "Review both builds after the game.",
    text: "Confirm or correct your opening and the opponent's strategy after an eligible 1v1 match. Automatic check-ins remain 1v1-only, not inferred for team games.",
  },
  {
    image: "/landing/companion-randomizer.png",
    width: 900, height: 480,
    caption: "Actual desktop settings · sample pool and read-only saved pick. Randomize is in check-in.",
    alt: "Companion Randomizer pool configuration and the saved result, using sample data",
    title: "Choose a pool. Randomize from check-in.",
    text: "Randomize saves one build even without an open widget. Companion settings silently configure the shared pool and display the saved pick. Randomizer animation, sound and spoken results stay in the widget. There is no native current-game Randomizer popup.",
  },
  {
    image: "/landing/companion-ghost.png",
    width: 1440, height: 1080, caption: "",
    alt: "Native Build Order Ghost with replay sources, player preview and matchup target, using sample data",
    title: "Practice from the replay you trust.",
    text: "Open a local replay or choose from your synced games. Preview a human player's build order and save a 1v1 matchup target, or explicitly arm a temporary target for a confirmed current team game.",
  },
] as const;

export function CompanionShowcase() {
  return (
    <section id="desktop-companion" aria-labelledby="companion-showcase-title" className="scroll-mt-24 border-t border-line py-16 md:py-24">
      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-end">
        <div className="min-w-0">
          <p className="kicker">Windows desktop Companion</p>
          <h2 id="companion-showcase-title" className="mt-4 max-w-2xl font-serif text-4xl font-semibold leading-tight text-text md:text-5xl">
            Your ladder desk, beside the game.
          </h2>
          <p className="mt-5 max-w-prose text-body-lg text-text-muted">
            Browse an interactive desktop scouting console. Keep the selected opponent&apos;s name, race, MMR and your record in view, compare both players&apos; replay build chains, then pin just the panels you want while you play.
          </p>
        </div>
        <div className="min-w-0">
          <div className="flex items-start gap-3 text-text-muted">
            <SlidersHorizontal className="mt-1 h-5 w-5 shrink-0 text-accent-cyan" aria-hidden />
            <p className="text-body">One game assistance switch, plus separate controls for Session, scouting, opponent panels, spoken scouting reports, build selectors and Ghost. Turn them on or off whenever you need.</p>
          </div>
          <p className="mt-4 text-caption text-text-muted">Runs without OBS for native scouting, Session, build selectors and Ghost. Randomize from check-in even when the separate widget is closed. Connected displays share one saved result; the widget handles animation, sounds and speech.</p>
          <p className="mt-3 text-caption text-text-muted">Home and Back keep browsing simple. Separate opponent and game arrows retain your place; Assistance and Agent menus keep the controls nearby.</p>
          <p className="mt-3 text-caption text-text-muted">Opt in to native Windows system-voice reports for fresh human 1v1 games or the selected confirmed live enemy in Hybrid team mode. Native scouting voice is unaffected by widget-only Randomizer playback. Voice, master and mode switches work together. OBS voice settings stay separate; keep only one scouting voice enabled to avoid duplicate audio.</p>
          <p className="mt-3 text-caption text-text-muted">Save your own Ladder, Customs, Teams, Practice and Review presets. Customize each feature locally, with an optional Ctrl+Shift+F10 master shortcut. Hybrid adds confirmed enemy selection for team scouting; automatic check-ins and randomizer draws remain 1v1-only.</p>
          <p role="note" aria-label="Companion availability" className="mt-4 rounded-sm border border-warning/40 bg-bg-surface p-3 text-caption text-text-muted"><strong className="font-semibold text-text">Use Agent 0.24.2 or later for these controls.</strong> Update from the shared Agent menu or download the Windows installer. Session requires pairing and an available SC2 Tools connection. Team scouting also needs fresh live SC2 telemetry; unknown history and MMR stay unavailable.</p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <LinkButton href="/download" size="sm" className="min-h-11" iconLeft={<Download className="h-4 w-4" aria-hidden />}>
              Download current stable agent
            </LinkButton>
            <Link href="/help/desktop-companion" className="inline-flex min-h-11 items-center gap-2 text-caption font-semibold text-text underline-offset-4 hover:underline">
              Explore Companion<ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </div>
      <div className="mt-9 grid min-w-0 gap-6 rounded-md border border-border bg-bg-surface p-4 sm:p-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] lg:items-center">
        <figure className="mx-auto w-full min-w-0 max-w-[420px] lg:mx-0">
          <Image src="/landing/companion-compact.png" alt="Transparent Compact Companion with a sample opponent's name, race, MMR, your record and win percentage, and a race-themed Scouting control" width={420} height={44} sizes="(max-width: 460px) 100vw, 420px" className="h-auto w-full" />
          <figcaption className="mt-2 text-micro text-text-dim">Compact layout · actual interface with sample data.</figcaption>
        </figure>
        <div className="min-w-0">
          <h3 className="font-serif text-2xl font-semibold text-text">Choose how much you see.</h3>
          <ul className="mt-4 grid gap-3 text-caption text-text-muted sm:grid-cols-2">
            <li><strong className="text-text">Compact</strong> — 420 × 44: transparent opponent text, race, MMR, your W–L and win percentage. The race button expands Standard between matches and toggles Scouting during a live game. Reopening the Agent restores Standard; pinned panels stay compact. Right-click for other window actions.</li>
            <li><strong className="text-text">Standard</strong> — 520 × 480: selected opponent information, including name, race, MMR, your W–L and win percentage, above both players&apos; build icon chains and recorded timings.</li>
            <li><strong className="text-text">Detailed</strong> — 1024 × 800: compare both tech trees and upgrade completion chains with more room.</li>
            <li><strong className="text-text">Full workspace</strong> — full stored build orders, notes, history, filters and replay tools.</li>
          </ul>
          <p className="mt-4 text-caption text-text-muted">Start with 3 minutes, then choose 6 minutes, 10 minutes or Full build order for both build and upgrade chains. Workers and supply are optional. Full build order shows all available stored events; older replay uploads can be incomplete.</p>
        </div>
      </div>
      <div className="mt-9 min-w-0 rounded-md border border-border bg-bg-surface p-4 sm:p-6" aria-labelledby="companion-session-title">
        <h3 id="companion-session-title" className="font-serif text-2xl font-semibold text-text">Your Session record, between games too.</h3>
        <p className="mt-3 max-w-prose text-body text-text-muted">The optional native Session panel is off by default. Pin your wins, losses and elapsed session time with the same race border as Companion. It shares the OBS widget&apos;s four-hour-inactivity record, not a calendar-day total, and does not require OBS or an active match.</p>
        <p className="mt-3 max-w-prose text-body text-text-muted">Your own latest-known MMR and rating region appear only when owned Session metadata provides them. Active server detection is unavailable from SC2&apos;s local API; missing values stay unavailable, not zero or an opponent&apos;s rating.</p>
        <p className="mt-3 max-w-prose text-body text-text-muted">Session reuses existing owned overlay access. If access is missing, setup requires explicit confirmation; polling and reconnects never create credentials automatically. The independent switch stops Session; master assistance off hides it without resetting its record or saved choice. Stale observations expire after 90 seconds.</p>
        <p className="mt-3 max-w-prose text-body text-text-muted">Pinned panels and main Compact automatically pass clicks through while StarCraft II is the verified foreground application. Only Compact&apos;s Scouting control stays clickable to open or close the shared detailed report. Alt+Tab away to unlock other controls. Standard stays interactive. Existing minimize and close-to-tray behavior is unchanged.</p>
        <figure className="mx-auto mt-6 w-full min-w-0 max-w-[720px]">
          <div className="overflow-hidden rounded-md border border-border-strong bg-[#10131f]">
            <Image src="/landing/companion-session.png" alt="Native Session record panels in Default, Protoss, Terran and Zerg styles, with sample wins, losses, elapsed time and your latest-known MMR and rating region" width={720} height={285} sizes="(max-width: 720px) 100vw, 720px" className="h-auto w-full" />
          </div>
          <figcaption className="mt-3 text-micro text-text-dim">Actual native panels · 150 × 138 each · sample data. Your latest-known MMR and rating region are not a verified active server.</figcaption>
        </figure>
      </div>
      <div className="mt-9 min-w-0 rounded-md border border-border bg-bg-surface p-4 sm:p-6" aria-labelledby="companion-team-hybrid-title">
        <h3 id="companion-team-hybrid-title" className="font-serif text-2xl font-semibold text-text">Hybrid team scouting, without guessing teams.</h3>
        <p className="mt-3 max-w-prose text-body text-text-muted">Compact follows one selected enemy; expanded layouts show the enemy roster. Standard keeps a small team summary with an Enemy roster button; Detailed and Full workspace show scrollable enemy cards. If authoritative team IDs are missing, explicitly confirm your own player and mark teammates and enemies. Right-click Compact to switch enemies without making the bar taller.</p>
        <p className="mt-3 max-w-prose text-body text-text-muted">Historical 1v1 MMR and head-to-head records are labeled as history, not current team-ladder ratings. Ambiguous identities remain unlinked until confirmed. Pinned panels and eligible speech follow the selected confirmed enemy.</p>
        <p className="mt-3 max-w-prose text-body text-text-muted">For team Ghost, preview a player whose race matches yours and choose Use this target in current team game. The temporary target clears when the game, roster, account, selected enemy or assistance state changes; saved 1v1 targets stay untouched. Full individual team-replay build streams require the original local replay.</p>
        <figure className="mx-auto mt-6 w-full min-w-0 max-w-[1024px]">
          <div className="overflow-hidden rounded-md border border-border-strong bg-[#10131f]">
            <Image src="/landing/companion-team-hybrid.png" alt="Detailed Companion Hybrid team roster with a selected enemy, historical 1v1 records and timed build chains, using sample data" width={1024} height={800} sizes="(max-width: 1024px) 100vw, 1024px" className="h-auto w-full" />
          </div>
          <figcaption className="mt-3 text-micro text-text-dim">Actual Detailed layout · 1024 × 800 · confirmed sample team roster, not current team ratings.</figcaption>
        </figure>
      </div>
      <figure className="mt-9 min-w-0">
        <div className="overflow-hidden rounded-md border border-border-strong bg-[#10131f] shadow-hard">
          <Image src="/landing/companion-workspace.png" alt="SC2 Tools purple Companion console with opponent portrait, Home and Back navigation and both players' replay timelines, using sample data" width={1440} height={900} sizes="(max-width: 1280px) 100vw, 1200px" className="h-auto w-full" />
        </div>
        <figcaption className="mt-3 text-micro text-text-dim">Actual desktop interface · screenshots use sample data.</figcaption>
      </figure>
      <div className="mt-10 min-w-0" aria-labelledby="companion-race-skins-title">
        <h3 id="companion-race-skins-title" className="font-serif text-2xl font-semibold text-text">Keep Default, or choose a race border.</h3>
        <p className="mt-3 max-w-prose text-body text-text-muted">Default preserves the current purple appearance unchanged. Optional Protoss, Terran and Zerg borders use original generated textured artwork: gold and cyan armor, blue steel, and organic shell. They are visual choices, independent of player and opponent race.</p>
        <p className="mt-2 max-w-prose text-body text-text-muted">Responsive frames preserve corner details across Compact, Standard, Detailed and Full workspace, without stretching the artwork over your information.</p>
        <p className="mt-2 max-w-prose text-body text-text-muted">Matching expansion animations run only when you explicitly expand the window. Turn animations off at any time for instant size changes.</p>
        <figure className="mx-auto mt-6 w-full min-w-0 max-w-[1040px]">
          <div className="overflow-hidden rounded-md border border-border-strong bg-[#10131f]">
            <Image src="/landing/companion-race-skins.png" alt="Static comparison of Default purple, Protoss, Terran and Zerg Companion borders using sample data" width={1040} height={1016} sizes="(max-width: 1040px) 100vw, 1040px" className="h-auto w-full" />
          </div>
          <figcaption className="mt-3 text-micro text-text-dim">Static race-art comparison · actual desktop interface with sample data.</figcaption>
        </figure>
      </div>
      <div className="mt-10 grid min-w-0 gap-8 md:grid-cols-2">
        {PANELS.map((panel) => (
          <div key={panel.title} className="min-w-0">
            <figure>
              <div className="overflow-hidden rounded-md border border-border-strong bg-[#10131f]">
                <Image src={panel.image} alt={panel.alt} width={panel.width} height={panel.height} sizes="(max-width: 767px) 100vw, 50vw" className="h-auto w-full" />
              </div>
              {panel.caption && <figcaption className="mt-3 text-micro text-text-dim">{panel.caption}</figcaption>}
            </figure>
            <h3 className="mt-4 font-serif text-2xl font-semibold text-text">{panel.title}</h3>
            <p className="mt-2 text-body text-text-muted">{panel.text}</p>
          </div>
        ))}
      </div>
      <p className="mt-6 max-w-prose text-caption text-text-muted">Pinned Opponent stays transparent; Scouting shares the Detailed build comparison and themed frame. Legacy Recent games details fill in gradually from already synced owned metadata, without resyncing or resetting upload history. Activity log excludes credential-bearing OBS SDK logs and repetitive connection-refused tracebacks; OBS remains optional.</p>
      <div className="mt-8 flex items-start gap-3 border-t border-border pt-5 text-caption text-text-muted">
        <Star className="mt-0.5 h-4 w-4 shrink-0 text-editorial" aria-hidden />
        <p>Star a reference replay for each build from Builds or Opponents. Keep your own examples handy, or practice from an example an admin has explicitly published.</p>
      </div>
    </section>
  );
}

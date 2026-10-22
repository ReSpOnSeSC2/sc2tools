"use client";

/**
 * Settings · Help — the new-user guide: how the pipeline works, how
 * to get the overlay and Stream Studio running, how build check-ins
 * work, what viewers can type in chat, and what to check when
 * something looks stuck. Purely presentational (no server state);
 * collapsible sections so the page scans fast, with Getting Started
 * open by default. A section with an ``id`` opens itself when the page
 * is reached through its anchor (e.g. ``?tab=help#build-check-in``).
 */

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, BookOpen, LifeBuoy, Mail } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { ChatCommandsCard } from "./ChatCommandsCard";

const SUPPORT_EMAIL = "responsecoaching@gmail.com";

function HelpSection({
  id,
  title,
  defaultOpen,
  children,
}: {
  id?: string;
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!id || !el || window.location.hash !== `#${id}`) return;
    el.open = true;
    el.scrollIntoView({ block: "start" });
  }, [id]);
  return (
    <details
      id={id}
      ref={ref}
      open={defaultOpen}
      className="group scroll-mt-20 rounded-lg border border-border bg-bg-elevated/40"
    >
      <summary className="cursor-pointer select-none list-none px-4 py-3 text-body font-medium text-text marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="mr-2 inline-block text-text-dim transition-transform group-open:rotate-90">
          ▸
        </span>
        {title}
      </summary>
      <div className="space-y-3 border-t border-border px-4 py-3 text-body text-text-muted">
        {children}
      </div>
    </details>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-surface text-micro font-bold text-accent-cyan">
        {n}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function SettingsHelp() {
  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <LifeBuoy className="h-5 w-5 text-accent-cyan" aria-hidden />
        <div>
          <div className="text-h3 font-semibold text-text">Help & getting started</div>
          <p className="text-caption text-text-dim">
            Everything in one place — setup, the overlay, the Stream
            Studio, viewer commands, and fixes for common snags.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <HelpSection title="Getting started (5 minutes)" defaultOpen>
          <Step n={1}>
            <b className="text-text">Install the desktop app</b> — download it
            from the home page and sign in with the same account. It watches
            your replay folder; you never upload anything by hand.
          </Step>
          <Step n={2}>
            <b className="text-text">Play normally</b> — every ladder game is
            read automatically a few seconds after it ends and synced to your
            account.
          </Step>
          <Step n={3}>
            <b className="text-text">Check the dashboard</b> — stats, builds,
            MMR and opponent history fill in as replays land. The Daily Pulse
            strip at the top rotates fresh insights every day.
          </Step>
          <Step n={4}>
            <b className="text-text">Stream?</b> Go to the Overlay tab, copy a
            widget URL into an OBS Browser Source, and press its Test button
            to see it live. That's the whole setup.
          </Step>
        </HelpSection>

        <HelpSection title="Dashboard & analyzer">
          <p>
            Everything is fed by your own replays — no manual tagging. The
            analyzer covers build win-rates (with MMR-band splits), map
            stats and veto help, opponent scouting (their openers, your
            head-to-head), MMR progression with peak/trough markers, and a
            custom build library you can save openings into. Strategy
            detection names the opener your opponent went for across 100+
            known builds.
          </p>
        </HelpSection>

        <HelpSection id="build-check-in" title="Build check-in: count the build you went for">
          <p>
            A game normally counts toward a build only when the replay
            matches every step of it, so games where you were knocked off
            the plan (a scouted proxy, lost workers, an early all-in) never
            count against that build. With <b className="text-text">Build
            check-in</b> you say which build you were going for, at the
            loading screen or after the game. A confirmed check-in counts
            the game toward that build&apos;s win/loss record even when the
            replay was classified as something else, so each build&apos;s
            record shows how the plan really does.
          </p>

          <p className="font-medium text-text">What you need</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              The <b className="text-text">desktop app, version 0.19.0 or
              newer</b>, running and signed in. It shows the in-game cards.
              Without it you can still check in from the website.
            </li>
            <li>
              StarCraft II in <b className="text-text">Windowed
              (Fullscreen)</b> or Windowed mode for the loading-screen card.
              It can&apos;t draw over exclusive Fullscreen; the after-game
              card and the website still work.
            </li>
            <li>
              1v1 games against a human. Team games, games vs the AI and
              games under 45 seconds are skipped.
            </li>
          </ul>

          <p className="font-medium text-text">Turn it on</p>
          <Step n={1}>
            Open{" "}
            <Link
              href="/settings?tab=checkin"
              className="font-medium text-accent-cyan underline-offset-2 hover:underline"
            >
              Settings → Build check-in
            </Link>
            . Three switches, all on by default:{" "}
            <b className="text-text">Build check-ins</b> (the master switch),{" "}
            <b className="text-text">Ask during the loading screen</b> and{" "}
            <b className="text-text">Ask after each game</b>. Press Save.
          </Step>
          <Step n={2}>
            The desktop app&apos;s Settings tab has the same three switches,
            kept in sync with the website. Every card also has a quick link
            to stop asking (<b className="text-text">Don&apos;t ask at
            loading</b>, <b className="text-text">Turn off check-ins after
            games</b>).
          </Step>

          <p className="font-medium text-text">How a game goes</p>
          <Step n={1}>
            <b className="text-text">Loading screen.</b> A small{" "}
            <b className="text-text">What&apos;s the plan?</b> card appears on
            the right side of the screen with the matchup and your opponent.
            Click one of <b className="text-text">Your builds</b>, sorted by
            how often you play them in this matchup and shown with your
            record, or open <b className="text-text">More builds…</b> for
            every build in the matchup (your saved custom builds plus the
            standard build list). The card never takes keyboard focus from
            the game: click and keep playing. It then shows{" "}
            <b className="text-text">Locked in</b> with a{" "}
            <b className="text-text">Change</b> button and goes away about 30
            seconds into the game. <b className="text-text">Not now</b> means
            you&apos;ll decide after the game.
          </Step>
          <Step n={2}>
            <b className="text-text">Build randomizer.</b> If the randomizer
            is on for the matchup, the card reads{" "}
            <i>Randomizer will roll — pick a build to skip it</i>. Pick a
            build and the randomizer doesn&apos;t roll on stream for that
            game; <b className="text-text">Roll now</b> rolls it right away;
            do nothing and it rolls after a few seconds. The rolled build is
            marked <b className="text-text">Rolled</b> and is treated as your
            plan: after the game it&apos;s pre-selected unless your replay
            clearly went a different way. You still confirm it.
          </Step>
          <Step n={3}>
            <b className="text-text">After the game.</b> When the game ends,{" "}
            <b className="text-text">Which build were you going for?</b>{" "}
            appears with a best guess already selected and a label saying
            why: you picked it at loading, it was the randomizer roll, it
            best matches your replay, it&apos;s your closest custom build, or
            it&apos;s your usual build for the matchup.{" "}
            <i>Replay classified as …</i> shows what the replay looked like.
            Press <b className="text-text">Confirm</b>, pick a different
            build, choose <b className="text-text">No set build</b> (you
            weren&apos;t going for anything in particular; the game keeps the
            replay&apos;s label) or <b className="text-text">Later</b>. Use the
            notes box for what threw the build off. Ctrl+Enter confirms, Esc
            means Later.
          </Step>
          <Step n={4}>
            <b className="text-text">Picked at loading?</b> If the replay
            matched your pick there&apos;s nothing to do. If it didn&apos;t, a
            short <b className="text-text">What happened?</b> card asks for a
            note: <b className="text-text">Done</b> keeps your pick,{" "}
            <b className="text-text">Change build</b> switches it.
          </Step>
          <Step n={5}>
            <b className="text-text">Missed one?</b> The{" "}
            <b className="text-text">Build check-ins (N)</b> chip in the header
            lists games from the last 72 hours that are waiting: Confirm,
            Change… or No set build, or Dismiss all. Every game page also has
            a <b className="text-text">Build check-in</b> card where you can
            set or change the planned build and edit your notes at any time.
            The desktop app&apos;s tray menu has{" "}
            <b className="text-text">Build check-in…</b> to reopen a card you
            closed.
          </Step>
          <p>
            Playing Random, or facing a Random opponent? There&apos;s no
            loading card because the matchup isn&apos;t known yet. You&apos;re
            asked after the game, with the real matchup.
          </p>

          <p className="font-medium text-text">How it counts</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Only confirmed check-ins change your stats. Suggestions and
              randomizer rolls never do on their own.
            </li>
            <li>
              A confirmed check-in counts in your Builds tab, build details,
              custom build library, MMR charts, trends and overlay widgets.{" "}
              <b className="text-text">incl. N check-ins</b> shows how many
              games count only because of a check-in; those games carry a{" "}
              <b className="text-text">Planned</b> badge with the
              replay&apos;s own label and your notes.
            </li>
            <li>
              Build timings, compositions and transitions only use games that
              actually followed the build, so a build&apos;s shape isn&apos;t
              diluted by games that went sideways.
            </li>
            <li>
              Community guides, ladder meta and coaching keep the
              replay&apos;s own label. Your check-ins only change your own
              stats.
            </li>
            <li>
              Games under 45 seconds never count toward a build.{" "}
              <b className="text-text">No set build</b> undoes a check-in.
            </li>
          </ul>

          <p className="font-medium text-text">On stream</p>
          <p>
            The desktop cards are hidden from screen capture, so OBS display
            or window capture won&apos;t show them, and your pick is never
            sent to overlay widgets or chat commands. Viewers only see the
            randomizer reveal, or no reveal when you picked a build first.
          </p>

          <p className="font-medium text-text">If something&apos;s missing</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <b className="text-text">No card at the loading screen?</b>{" "}
              Check that the desktop app is running and up to date, that{" "}
              <i>Ask during the loading screen</i> is on, that StarCraft II
              isn&apos;t in exclusive Fullscreen, and that it&apos;s a 1v1 vs a
              human. Random games only ask after the game.
            </li>
            <li>
              <b className="text-text">No card after the game?</b>{" "}
              <i>Ask after each game</i> must be on. If the replay uploads
              late (offline, or with replay capture on), check in from the
              header chip or the game page.
            </li>
            <li>
              <b className="text-text">Randomizer rolled a few seconds
              late?</b> That&apos;s the short hold while you decide;{" "}
              <i>Roll now</i> skips it, and turning off{" "}
              <i>Ask during the loading screen</i> removes it.
            </li>
          </ul>
        </HelpSection>

        <HelpSection title="OBS overlay setup">
          <Link
            href="/stream-studio/learn"
            className="inline-flex min-h-11 items-center gap-2 rounded-sm font-semibold text-accent-cyan underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <BookOpen className="h-4 w-4 shrink-0" aria-hidden />
            Stream Studio crash course & widget guides
            <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
          </Link>
          <p>Learn what each widget does, choose a starting setup, and follow the steps to put it in OBS.</p>
          <Step n={1}>
            In <b className="text-text">Settings → Overlay</b>, create (or
            copy) an overlay token — the token IS the key, so treat the URLs
            like passwords.
          </Step>
          <Step n={2}>
            Each widget has its own URL — add one OBS{" "}
            <b className="text-text">Browser Source</b> per widget you want and
            position it freely. Backgrounds are transparent.
          </Step>
          <Step n={3}>
            Press <b className="text-text">Test</b> on any widget to render
            clearly-labelled sample content for ~20 seconds — place and style
            everything without waiting for a real game.
          </Step>
          <Step n={4}>
            Widgets show up when something happens (a game starts or ends)
            and auto-hide between games; persistent HUDs like the session
            record stay up. Config changes reach OBS within about a minute of
            pressing Save — no Browser Source edits needed.
          </Step>
        </HelpSection>

        <HelpSection title="Multi-platform chat (Twitch · Kick · YouTube · TikTok)">
          <p>
            One Browser Source merges all four chats. Setup per platform, in{" "}
            <b className="text-text">Overlay → Multi-platform chat</b>:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <b className="text-text">Twitch</b> — channel name only (anonymous
              read-only connection, no OAuth).
            </li>
            <li>
              <b className="text-text">Kick</b> — channel name plus a one-time
              chatroom-id detection; if Kick's bot protection blocks it, the
              guided manual flow walks you through a copy-paste.
            </li>
            <li>
              <b className="text-text">YouTube</b> — channel handle or URL; the
              chats from your public live broadcasts, including separate
              landscape and vertical streams, are combined automatically.
              Use a live-video URL to follow only that broadcast.
            </li>
            <li>
              <b className="text-text">TikTok</b> — @username only,{" "}
              <b className="text-text">no stream key needed</b>. Offline, the
              widget idles and reconnects when you go live.
            </li>
          </ul>
          <p>
            From the same page you control the full appearance studio (live
            preview), alert sounds (50+ bundled real recordings and synth
            effects, plus your own via link / upload / typed voice line —
            note that famous copyrighted clips can trigger VOD muting),
            text-to-speech chat readout, and free on-device translation.
          </p>
        </HelpSection>

        <HelpSection title="Stream Dock (your control panel)">
          <p>
            The Stream Dock URL (shown in the multichat settings) is a
            second-screen control panel — add it in OBS via{" "}
            <b className="text-text">Docks → Custom Browser Docks</b>, or open
            it on a phone. From it you can: pin a chat highlight on stream
            (and have it read aloud), run chat polls and{" "}
            <b className="text-text">build votes</b> (chat picks your opening
            from your real saved builds), update stream goals, switch{" "}
            <b className="text-text">BRB / Starting Soon scenes</b> with a
            countdown, fire the session recap card, review the{" "}
            <b className="text-text">clip-moment log</b> (every chat spike and
            big game moment, timestamped with the chat lines that caused it),
            and block spammers everywhere at once.
          </p>
        </HelpSection>

        <HelpSection title="Viewer engagement: XP, ranks & predictions">
          <p>
            Viewers on all four platforms share one progression: 2 XP per
            chat message plus bonuses for subs, raids, gifts and Super
            Chats. Levels climb a StarCraft unit ladder themed by the race
            you pick in the multichat settings; the supporter wall shows
            today's top 5 and announces level-ups on stream. Before each of
            your games, chat calls <code>!win</code> or <code>!loss</code> —
            the verified result awards oracle points and shows whether chat
            was right. Everything below is what your viewers can type:
          </p>
          <ChatCommandsCard rankRace="protoss" />
          <p className="text-caption text-text-dim">
            Tip: the same card in Overlay → Multi-platform chat copies the
            bio text with YOUR saved rank race. Enable the <b>Chat bot</b>{" "}
            there too and the answers post right in Twitch chat — it also
            counts <code>!win</code>/<code>!loss</code> calls and XP with
            the dock closed, and announces Crystal Ball results and
            level-ups.
          </p>
        </HelpSection>

        <HelpSection title="Troubleshooting & support">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <b className="text-text">Changes not showing in OBS?</b> Press
              Save first — widgets re-read their config within ~60 seconds. If
              it still looks stale, right-click the Browser Source →
              Interact/Refresh, or "Refresh cache of current page".
            </li>
            <li>
              <b className="text-text">No sound or voice?</b> Browsers can
              block audio until a click — open the source with Interact and
              click once, then TTS/sounds run normally.
            </li>
            <li>
              <b className="text-text">Kick won't auto-detect?</b> Use the
              guided manual flow in the Kick row — open the shown URL in your
              own browser and paste what you see; the id is extracted for
              you.
            </li>
            <li>
              <b className="text-text">Widget blank?</b> Check the widget is
              enabled for your token in Settings → Overlay, and use its Test
              button to confirm placement.
            </li>
          </ul>
          <p className="flex flex-wrap items-center gap-1.5">
            <Mail className="h-4 w-4 text-accent-cyan" aria-hidden />
            Ran into a bug or something confusing? Email{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="font-medium text-accent-cyan underline-offset-2 hover:underline"
            >
              {SUPPORT_EMAIL}
            </a>{" "}
            — include what you clicked and a screenshot if you can.
          </p>
        </HelpSection>
      </div>
    </Card>
  );
}

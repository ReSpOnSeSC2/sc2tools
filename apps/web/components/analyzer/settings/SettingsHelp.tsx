"use client";

/**
 * Settings · Help — the new-user guide: how the pipeline works, how
 * to get the overlay and Stream Studio running, what viewers can
 * type in chat, and what to check when something looks stuck.
 * Purely presentational (no server state); collapsible sections so
 * the page scans fast, with Getting Started open by default.
 */

import type { ReactNode } from "react";
import { LifeBuoy, Mail } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { ChatCommandsCard } from "./ChatCommandsCard";

const SUPPORT_EMAIL = "responsecoaching@gmail.com";

function HelpSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-lg border border-border bg-bg-elevated/40"
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

        <HelpSection title="OBS overlay setup">
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
              live stream is discovered automatically each time you go live.
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

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

const PROBLEMS = [
  { title: "Check your overlay before going live", body: "Open Ready to go live? in Overlay setup to check connected sources, unknown older pages and possible duplicate audio. Counts include source pages opened in a browser; check the actual scene and audio in OBS too.", href: "/help/overlay-health", action: "Is my overlay ready?" },
  {
    title: "The source says the link is no longer valid",
    body: "The overlay token was revoked or rotated, or the URL was mistyped. Copy a fresh URL from Settings → Overlay and replace it in the Browser Source or Stream Dock. A temporary outage reconnects automatically. Add ?check=1 (or &check=1 after an existing query) to see a connection badge for 10 seconds inside OBS.",
    href: "/settings?tab=overlay", action: "Copy a fresh overlay link",
  },
  {
    title: "Test works, but a real game shows nothing",
    body: "Test checks sample rendering, not your agent's data path. During a detected live match, Settings asks before broadcasting samples: Preview here instead opens a local sample page; Send anyway shows viewers samples for about 20 seconds. Stop restores the current real opponent and session. Check Devices for a paired, recently seen agent and keep it running. Live widgets need a detected match; result widgets need the completed replay to finish syncing. Opponent-history cards also need usable history. Browser-only analysis does not replace the agent's live connection.",
    href: "/devices", action: "Check my agent",
  },
  {
    title: "Nothing appears, even when I press Test",
    body: "Open the right scene and make the Browser Source visible. Put it above the game capture in the Sources list, check that you copied this widget's URL, and enable the widget in Settings. Chat, studio widgets and Ghost Build use their own Browser Sources. Build profile has no Test button: save all five ratings, then use Show widget. Follow the individual guide for widgets controlled from the Stream Dock.",
    href: "/settings?tab=overlay", action: "Check Overlay settings",
  },
  {
    title: "The card disappears, or only some cards appear",
    body: "Many widgets are brief announcements, so they clear after their event. Session record and practice HUDs behave differently. A rematch, streak or cheese alert only appears when its conditions are met; an empty history card can mean there is not enough data. Read 'When it appears' in the widget guide before treating a quiet source as a failure. Change Display time in Settings → Overlay → Widgets → Display and Save overlay display for the next appearance. Default uses the usual time; Tests respect shorter settings and stay capped at 20s. Persistent and self-driven widgets keep their own visibility rules.",
    href: "#widget-library", action: "Find the widget's trigger",
  },
  {
    title: "The widget is cut off or far too large",
    body: "Browser Source width and height set the page's drawing area. Change those in source properties before resizing the source on your scene. Start a landscape All-in-one source at your canvas size, for example 1920 × 1080. For individual sources, leave enough room around the card; Build profile uses 720 × 900. Use the overlay appearance controls for text and panel size, then Save overlay display to update connected sources. Older URLs with a ?theme= override keep that look; remove the override once to follow saved changes.",
    href: "/settings?tab=overlay", action: "Adjust appearance",
  },
  {
    title: "I hear the same voice or alert twice",
    body: "Look for two active sources playing the same feature, especially All-in-one plus a separate widget. Keep one audible copy. The Stream Dock is a control panel, not an on-stream Browser Source. For scouting speech, choose your voice and event preferences in Voice settings, and use OBS's Interact window if the browser asks for a click to enable sound.",
    href: "/settings?tab=voice", action: "Open Voice settings",
  },
  {
    title: "Chat is empty, or an alert isn't arriving",
    body: "Check your platform identifiers in Multi-platform chat and whether that channel is live. A sample chat test verifies layout, not a real platform connection. Event alerts also depend on the platform's available event connection and permissions; connecting chat alone does not guarantee every subscription, raid or gift event. Open the Stream Dock to inspect the feed and configuration.",
    href: "/settings?tab=overlay", action: "Review chat setup",
  },
] as const;

export function LearnTroubleshooting() {
  return (
    <section id="troubleshooting" aria-labelledby="learn-troubleshooting-title" className="scroll-mt-28 pt-16 md:pt-24">
      <p className="kicker">Get unstuck</p>
      <h2 id="learn-troubleshooting-title" className="mt-3 font-serif text-3xl font-semibold text-text md:text-4xl">Start with what you can see.</h2>
      <p className="mt-4 max-w-2xl text-body-lg text-text-muted">A quiet widget is sometimes waiting for its event. These checks help you tell the difference.</p>
      <div className="mt-7 space-y-3">
        {PROBLEMS.map((problem) => (
          <details key={problem.title} className="group rounded-md border-2 border-line bg-bg-surface p-4 sm:p-5">
            <summary className="min-h-11 cursor-pointer py-2 text-body font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{problem.title}</summary>
            <p className="mt-4 max-w-4xl text-body text-text-muted">{problem.body}</p>
            <Link href={problem.href} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded text-caption font-semibold text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{problem.action}<ArrowUpRight className="h-4 w-4" aria-hidden /></Link>
          </details>
        ))}
      </div>
      <details className="mt-6 rounded-md border border-border bg-bg-elevated/50 p-5">
        <summary className="cursor-pointer font-display text-h4 font-bold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Jargon, translated</summary>
        <dl className="mt-5 grid gap-5 text-body sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Widget", "One piece of information or one on-stream feature, such as a scoreboard or a poll."],
            ["Browser Source", "A web page OBS or Streamlabs draws on top of your scene. You paste your widget URL into it."],
            ["Overlay URL", "Your private link to a widget. It gives the source access to your overlay; keep it out of public chat and screenshots."],
            ["Paired agent", "The desktop app linked to your SC2 Tools account. It sends game information from the PC where you play."],
            ["Stream Dock", "Your backstage control panel for polls, highlights and scenes. Open it separately; viewers see the widgets it controls."],
            ["Event widget", "A card that waits for something to happen, shows briefly, then clears. It doesn't need to stay visible to be working."],
          ].map(([term, meaning]) => <div key={term}><dt className="font-semibold text-text">{term}</dt><dd className="mt-1 text-text-muted">{meaning}</dd></div>)}
        </dl>
      </details>
      <p className="mt-6 text-caption text-text-dim">For the streaming app itself: <a href="https://obsproject.com/kb/browser-source" target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4 hover:text-accent-hover">OBS Browser Source reference</a> · <a href="https://support.streamlabs.com/hc/en-us/articles/46771000147739-How-to-Get-Started-with-Streamlabs-Custom-Widgets#how-to-add-multiple-custom-widgets-in-streamlabs-desktop" target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4 hover:text-accent-hover">Streamlabs Browser Source walkthrough</a>.</p>
    </section>
  );
}

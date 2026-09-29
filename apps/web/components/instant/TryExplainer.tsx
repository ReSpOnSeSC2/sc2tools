/**
 * TryExplainer — the static, crawlable half of /try: what the in-browser
 * StarCraft II replay analyzer is, what its report shows, where replays
 * live on disk, and how it compares with the desktop agent.
 *
 * Server-rendered below the interactive tool (which only shows its full
 * report once a visitor adds replays), so search engines and first-time
 * visitors see a complete description of the page. Every claim mirrors
 * the tool's real behaviour: the replay cap (MAX_TRY_FILES), 1v1 only,
 * on-device analysis, the report sections in lib/instant/report.ts and
 * the folder paths in lib/instant/fileIntake.ts.
 *
 * Example:
 *   <TryExplainer />
 */
import Link from "next/link";
import { guidesEnabled } from "@/lib/guides/flags";
import { MAX_TRY_FILES } from "@/lib/instant/fileIntake";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com";

const REPORT_ITEMS: ReadonlyArray<string> = [
  "Your record by matchup: wins and losses against each race.",
  "Your openers: the win rate of every build SC2 Tools detects in your games.",
  "What your opponents opened with, and how you did against each strategy.",
  "Your most-faced opponent and your MMR on each account and ladder queue.",
  "A macro score with your biggest leaks, and why you lost your most recent game.",
  "A game-by-game list of every replay you added.",
];

const FOLDERS: ReadonlyArray<{ os: string; path: string }> = [
  { os: "Windows", path: "Documents\\StarCraft II\\Accounts" },
  { os: "macOS", path: "~/Library/Application Support/Blizzard/StarCraft II/Accounts" },
];

const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "Do my replays get uploaded?",
    a: "No. The replays are read on your device and never leave your browser. The parsed games stay on this device for 7 days; only if you choose to save them to a free account are the parsed games (not the replay files) uploaded.",
  },
  {
    q: "Which replays can it analyze?",
    a: `1v1 StarCraft II replays (.SC2Replay). Add single files, a .zip, or a whole folder; the newest ${MAX_TRY_FILES} games are analyzed per run.`,
  },
  {
    q: "Does it work on a Mac, Chromebook or iPad?",
    a: "Yes. The analyzer runs in the browser, so it works anywhere a modern browser does, as long as you can get your replay files onto the device.",
  },
  {
    q: "What does the desktop agent add?",
    a: "The free Windows agent syncs every game automatically as you play and powers the live features a web page can't reach: pre-game opponent scouting, the OBS overlays and scene switching.",
  },
];

/** WebApplication structured data for the analyzer. */
const WEB_APP_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "SC2 Tools Replay Analyzer",
  url: `${SITE_URL}/try`,
  applicationCategory: "GameApplication",
  operatingSystem: "Any (runs in a web browser)",
  browserRequirements: "Requires JavaScript and WebAssembly",
  description:
    "Free StarCraft II replay analyzer that runs in your browser: record by matchup, openers, opponent strategies, macro and why you lost, with no download or account.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

function SectionHeading({ children }: { children: string }) {
  return <h2 className="font-display text-h2 text-text">{children}</h2>;
}

export function TryExplainer() {
  return (
    <section aria-labelledby="try-explainer-title" className="mx-auto mt-16 max-w-4xl space-y-10 border-t border-border pt-12">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(WEB_APP_JSON_LD) }} />
      <div className="space-y-3">
        <h2 id="try-explainer-title" className="font-display text-h2 text-text">
          A free StarCraft II replay analyzer that runs in your browser
        </h2>
        <p className="max-w-prose text-body-lg text-text-muted">
          SC2 Tools reads your .SC2Replay files with the same analysis engine as its desktop agent, running right
          inside this page. Add up to {MAX_TRY_FILES} replays and the report is ready in moments, with nothing to
          install and no account needed.
        </p>
      </div>

      <div className="space-y-3">
        <SectionHeading>What the replay report shows</SectionHeading>
        <ul className="max-w-prose list-disc space-y-2 pl-5 text-body text-text">
          {REPORT_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <div className="space-y-3">
        <SectionHeading>Where to find your StarCraft II replays</SectionHeading>
        <p className="max-w-prose text-body text-text-muted">
          StarCraft II saves replays inside its Accounts folder. Choose that whole folder, or drag it onto the
          analyzer, and it finds the replays for you.
        </p>
        <dl className="grid gap-3 sm:grid-cols-2">
          {FOLDERS.map(({ os, path }) => (
            <div key={os} className="min-w-0 rounded-lg border border-border bg-bg-surface p-3">
              <dt className="text-caption font-semibold text-text-muted">{os}</dt>
              <dd className="mt-1 break-all font-mono text-caption text-text">{path}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="space-y-3">
        <SectionHeading>Questions</SectionHeading>
        <div className="space-y-4">
          {FAQ.map(({ q, a }) => (
            <div key={q} className="max-w-prose">
              <h3 className="text-body-lg font-semibold text-text">{q}</h3>
              <p className="mt-1 text-body text-text-muted">{a}</p>
            </div>
          ))}
        </div>
        <p className="max-w-prose text-body text-text-muted">
          Want every game analyzed automatically?{" "}
          <Link href="/download" className="font-semibold text-accent underline-offset-4 hover:underline">
            Get the free desktop agent
          </Link>
          {guidesEnabled() ? (
            <>
              {" "}or see the{" "}
              <Link href="/guides" className="font-semibold text-accent underline-offset-4 hover:underline">
                build-order guides
              </Link>{" "}
              built from real ladder replays
            </>
          ) : null}
          .
        </p>
      </div>
    </section>
  );
}

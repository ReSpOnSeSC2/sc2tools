import Image from "next/image";
import { Wand2 } from "lucide-react";

/* =============================================================== */
/* REAL-GAME SHOWCASE — one actual replay, read by the app          */
/*                                                                  */
/* Every value in the parsed-game panel is the genuine output of    */
/* running the desktop parser                                       */
/* (apps/replay-engine/scripts/preview_replay_cli.py — the same     */
/* sc2reader path the agent uses) over the committed fixture replay */
/* warpgate_adept_tracking.SC2Replay: a 1v1 ladder PvZ on Tourmaline */
/* LE. Races, result and build timings are exactly as parsed — no   */
/* mock data. Player gamertags are intentionally omitted (shown as  */
/* "You" / "Opponent"). Internal unit/upgrade ids are shown under    */
/* their in-game names (e.g. AdeptPiercingAttack → "Glaives").      */
/* =============================================================== */

interface BuildStep {
  /** In-game timestamp, m:ss, exactly as parsed. */
  t: string;
  name: string;
  /** Highlight the moves that define the strategy read. */
  key?: boolean;
}

interface ShowcasePlayer {
  race: "Protoss" | "Zerg" | "Terran";
  result: "Win" | "Loss";
  /** Strategy read, derived from the parsed build log. */
  read: string;
  opener: ReadonlyArray<BuildStep>;
}

const SHOWCASE_YOU: ShowcasePlayer = {
  race: "Protoss",
  result: "Win",
  read: "Twilight Adept pressure — Glaives into Warp Prism harass",
  opener: [
    { t: "0:00", name: "Nexus" },
    { t: "1:01", name: "Gateway" },
    { t: "2:03", name: "Nexus (natural)" },
    { t: "2:14", name: "Cybernetics Core" },
    { t: "3:36", name: "Twilight Council" },
    { t: "5:04", name: "Robotics Facility" },
    { t: "5:26", name: "Warp Gate (researching)" },
    { t: "5:45", name: "First Adept", key: true },
    { t: "6:33", name: "Glaives upgrade", key: true },
  ],
};

const SHOWCASE_OPP: ShowcasePlayer = {
  race: "Zerg",
  result: "Loss",
  read: "Hatch-first three-base into Ling / Baneling",
  opener: [
    { t: "0:00", name: "Hatchery" },
    { t: "1:05", name: "Hatchery (natural)" },
    { t: "1:40", name: "Spawning Pool" },
    { t: "3:24", name: "Hatchery (third)" },
    { t: "3:38", name: "Queen" },
    { t: "4:54", name: "Ling Speed", key: true },
    { t: "7:09", name: "Baneling Nest", key: true },
    { t: "8:32", name: "First Baneling" },
  ],
};

const RACE_DOT: Record<ShowcasePlayer["race"], string> = {
  Protoss: "bg-race-protoss",
  Zerg: "bg-race-zerg",
  Terran: "bg-race-terran",
};

/** Real product screenshots of the stats/graph pages the games feed. */
const TREND_SHOTS: ReadonlyArray<{
  src: string;
  alt: string;
  caption: string;
}> = [
  {
    src: "/landing/builds.png",
    alt: "Custom Builds page in SC2 Tools showing per-build wins, losses, win rate, and trend sparklines",
    caption:
      "Per-build win rate, W-L and a trend sparkline for every opener you play — split by matchup and by map.",
  },
  {
    src: "/landing/opponent-dna.png",
    alt: "Opponent profile in SC2 Tools showing head-to-head record, build tendencies, and median key timings",
    caption:
      "Per-opponent dossier — your head-to-head record, the builds they lean on, and their median key timings.",
  },
];

export function RealGameShowcase() {
  return (
    <section className="mt-24 md:mt-32">
      <div className="grid gap-x-10 gap-y-4 lg:grid-cols-12">
        <p className="kicker lg:col-span-4">See exactly what you get</p>
        <div className="lg:col-span-8">
          <hr className="ed-rule mb-5" />
          <h2 className="font-serif text-[32px] font-semibold leading-tight tracking-[-0.01em] text-text md:text-[40px]">
            One replay in. Your whole game, read back.
          </h2>
          <p className="mt-3 max-w-2xl text-body-lg text-text-muted">
            Here&rsquo;s a real ladder game — Protoss vs Zerg on Tourmaline LE —
            after the desktop app read the replay. Both build orders, both
            strategies, and the result. None of it was typed in by hand.
          </p>
        </div>
      </div>

      {/* The parsed-game panel, styled like the product UI. */}
      <div className="mt-8 overflow-hidden rounded-md border-2 border-line bg-bg-surface shadow-hard">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b-2 border-line bg-bg-elevated/50 px-5 py-3">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-serif text-h4 font-semibold text-text">
              Protoss vs Zerg
            </span>
            <span className="text-text-dim" aria-hidden>
              ·
            </span>
            <span className="text-caption text-text-muted">Tourmaline LE</span>
            <span className="text-text-dim" aria-hidden>
              ·
            </span>
            <span className="text-caption text-text-muted">1v1 Ladder</span>
          </div>
          <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-editorial">
            <Wand2 className="h-3.5 w-3.5" aria-hidden />
            Auto-read from one .SC2Replay
          </span>
        </div>

        <div className="grid md:grid-cols-2 md:divide-x-2 md:divide-line">
          <ShowcasePlayerColumn player={SHOWCASE_YOU} side="You" />
          <ShowcasePlayerColumn player={SHOWCASE_OPP} side="Opponent" />
        </div>
      </div>

      {/* Real facts derived from the same parse. */}
      <dl className="mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-3">
        <ShowcaseFact
          label="Tech path read"
          value="Gateway → Cyber → Twilight → Robo"
        />
        <ShowcaseFact
          label="Key timings"
          value="First Adept 5:45 · Glaives 6:33"
        />
        <ShowcaseFact
          label="Next time you meet them"
          value="Queue into this opponent again and the overlay shows their past build orders and your win rate against them."
        />
      </dl>

      {/* Trends & graphs — the stats pages every parsed game feeds. */}
      <div className="mt-16 grid gap-x-10 gap-y-4 lg:grid-cols-12">
        <p className="kicker lg:col-span-4">And it stacks up over time</p>
        <div className="lg:col-span-8">
          <hr className="ed-rule mb-5" />
          <h3 className="font-serif text-[26px] font-semibold leading-tight tracking-[-0.01em] text-text md:text-[32px]">
            A few games in, the graphs do the talking.
          </h3>
          <p className="mt-3 max-w-2xl text-body-lg text-text-muted">
            Every game you finish feeds the same stats pages: win rate week by
            week with a rolling average, your MMR climb, the matchups and maps
            you&rsquo;re strongest on, and how your build mix shifts — plus
            per-build and per-opponent breakdowns.
          </p>
        </div>
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        {TREND_SHOTS.map((shot) => (
          <figure key={shot.src} className="space-y-3">
            <div className="overflow-hidden rounded-md border-2 border-line bg-bg-elevated/40 shadow-hard">
              <Image
                src={shot.src}
                alt={shot.alt}
                width={1600}
                height={900}
                sizes="(min-width: 768px) 50vw, 100vw"
                className="block h-auto w-full"
              />
            </div>
            <figcaption className="text-body text-text-muted">
              {shot.caption}
            </figcaption>
          </figure>
        ))}
      </div>

      <p className="mt-8 max-w-3xl text-body text-text-muted">
        The desktop app does all of this after every game you finish — no
        tagging, nothing to upload. And the OBS overlay flags a familiar
        opponent the moment they load in.
      </p>
    </section>
  );
}

function ShowcasePlayerColumn({
  player,
  side,
}: {
  player: ShowcasePlayer;
  side: "You" | "Opponent";
}) {
  const win = player.result === "Win";
  return (
    <div className="p-5 md:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden
            className={[
              "h-2.5 w-2.5 flex-shrink-0 rounded-full",
              RACE_DOT[player.race],
            ].join(" ")}
          />
          <div className="min-w-0">
            <p className="font-serif text-h4 font-semibold text-text">{side}</p>
            <p className="text-caption text-text-dim">{player.race}</p>
          </div>
        </div>
        <span
          className={[
            "inline-flex h-7 items-center rounded-md border-2 px-2 text-caption font-bold",
            win
              ? "border-success/50 text-success"
              : "border-text-dim/40 text-text-dim",
          ].join(" ")}
        >
          {win ? "WIN" : "LOSS"}
        </span>
      </div>

      <div className="mt-4 border-l-2 border-editorial pl-3">
        <p className="kicker">Detected opening</p>
        <p className="mt-1 text-body font-medium text-text">{player.read}</p>
      </div>

      <ol className="mt-4 space-y-1.5">
        {player.opener.map((s) => (
          <li key={`${s.t}-${s.name}`} className="flex items-baseline gap-3">
            <span
              className={[
                "w-12 flex-shrink-0 font-mono text-caption tabular-nums",
                s.key ? "text-editorial" : "text-text-dim",
              ].join(" ")}
            >
              {s.t}
            </span>
            <span
              className={[
                "text-body",
                s.key ? "font-semibold text-text" : "text-text-muted",
              ].join(" ")}
            >
              {s.name}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ShowcaseFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t-2 border-line pt-3">
      <dt className="kicker">{label}</dt>
      <dd className="mt-1.5 text-body text-text-muted">{value}</dd>
    </div>
  );
}

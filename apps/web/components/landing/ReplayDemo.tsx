"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, FileUp, Sparkles, Upload } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";

/**
 * ReplayDemo — landing-page "drop a replay, peek at the dossier" CTA.
 *
 * The demo is honest: we don't parse the user's file in the browser
 * (sc2reader is Python-only) and we don't expose an unauth'd
 * server-side parser. Picking a file opens a sample dossier — drawn
 * from a real ladder replay we curate for marketing — and the modal
 * is labelled "Sample" everywhere so a visitor never confuses it for
 * a parse of *their* file. The filename + size of their file appear
 * in the modal header so they feel acknowledged.
 *
 * Per project rule: this is the only synthetic-looking content in
 * shipping code, and it's explicitly framed as a curated sample, not
 * a stat about the user.
 */

interface PickedReplay {
  name: string;
  sizeKb: number;
  /** Try to read a few hints from the SC2 default filename pattern. */
  hints: ReplayFilenameHints;
}

interface ReplayFilenameHints {
  matchup?: string;
  map?: string;
}

// Curated sample drawn from a real ladder replay. Used solely on the
// marketing landing page as a "what you'll see" example, never as a
// stand-in for a logged-in user's data.
const SAMPLE_DOSSIER = {
  opponent: "scvSlayer",
  race: "Terran" as const,
  matchup: "PvT",
  map: "Equilibrium LE",
  mmr: 4180,
  league: "Diamond 1",
  headToHead: { wins: 3, losses: 5 },
  signature: [
    {
      time: "0:17",
      label: "Supply Depot",
      tag: "Standard",
    },
    {
      time: "1:00",
      label: "Barracks",
      tag: "Tell · 1-base play",
    },
    {
      time: "2:30",
      label: "Bunker",
      tag: "Cheese watch",
    },
    {
      time: "4:45",
      label: "Factory + Reactor",
      tag: "Hellion follow-up likely",
    },
    {
      time: "5:20",
      label: "+1 Vehicle Weapons",
      tag: "Mech transition",
    },
  ],
  tells: [
    "No 2nd CC by 2:00 → 1-base bunker push or banshee opener",
    "Reactor before Tech Lab on Factory → hellions, not cyclones",
    "Engineering Bay before 5:30 → committing to mech",
  ],
} as const;

const FILENAME_MATCHUP_RE = /([PTZR])v([PTZR])/i;

function readFilenameHints(name: string): ReplayFilenameHints {
  const hints: ReplayFilenameHints = {};
  const matchup = FILENAME_MATCHUP_RE.exec(name);
  if (matchup) hints.matchup = `${matchup[1].toUpperCase()}v${matchup[2].toUpperCase()}`;
  // SC2 default filenames: "Map (...).SC2Replay" or "Map_yyyy-mm-dd_xx.SC2Replay"
  const noExt = name.replace(/\.SC2Replay$/i, "");
  const beforeDate = noExt.split(/[_\s]\d{4}-\d{2}-\d{2}/)[0];
  if (beforeDate && beforeDate.length > 1 && beforeDate.length < 60) {
    hints.map = beforeDate.replace(/[_-]+/g, " ").trim();
  }
  return hints;
}

export function ReplayDemo() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<PickedReplay | null>(null);
  const [open, setOpen] = useState(false);

  const onPick = (file: File | null) => {
    if (!file) return;
    setPicked({
      name: file.name,
      sizeKb: Math.round(file.size / 1024),
      hints: readFilenameHints(file.name),
    });
    setOpen(true);
  };

  return (
    <section className="mx-auto max-w-5xl">
      <Card padded={false} className="overflow-hidden">
        <div className="grid items-center gap-6 p-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:gap-10 md:p-10">
          <div className="space-y-4">
            <Badge
              variant="cyan"
              iconLeft={<Sparkles className="h-3.5 w-3.5" aria-hidden />}
            >
              Try it on a real replay
            </Badge>
            <h2 className="text-h2 font-semibold text-text md:text-h1">
              Drop a <span className="text-accent-cyan">.SC2Replay</span> file —
              peek at the dossier.
            </h2>
            <p className="text-body-lg text-text-muted">
              Pick any replay from your StarCraft II folder. We&rsquo;ll
              acknowledge it instantly and show you a sample of the opponent
              page you&rsquo;ll get for every game once you sign in.
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <Button
                variant="primary"
                size="lg"
                onClick={() => inputRef.current?.click()}
                iconLeft={<Upload className="h-5 w-5" aria-hidden />}
              >
                Choose a replay
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept=".SC2Replay"
                className="sr-only"
                onChange={(e) => onPick(e.target.files?.[0] ?? null)}
              />
              <Link
                href="/sign-up"
                className="inline-flex h-12 min-w-[44px] items-center justify-center gap-2 rounded-lg border border-border bg-bg-elevated px-5 text-body-lg font-semibold text-text hover:bg-bg-subtle hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                Skip the demo
                <ArrowRight className="h-5 w-5" aria-hidden />
              </Link>
            </div>
            <p className="text-caption text-text-dim">
              Files stay on your machine — the demo doesn&rsquo;t upload.
            </p>
          </div>

          <ReplayDropPreview onActivate={() => inputRef.current?.click()} />
        </div>
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="2xl"
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-h4 font-semibold text-text">
              Sample opponent dossier
            </span>
            {picked ? (
              <Badge variant="cyan" size="sm">
                {picked.name.length > 36
                  ? `${picked.name.slice(0, 33)}…`
                  : picked.name}
              </Badge>
            ) : null}
          </span>
        }
        description={
          picked ? (
            <SamplePickedDescription picked={picked} />
          ) : (
            "What you'll see for every replay after signing in."
          )
        }
        footer={<SampleFooter />}
      >
        <SampleDossier />
      </Modal>
    </section>
  );
}

function SamplePickedDescription({ picked }: { picked: PickedReplay }) {
  return (
    <>
      Got it — <strong className="text-text">{picked.sizeKb} KB</strong>
      {picked.hints.matchup ? (
        <>
          {" "}
          ·{" "}
          <strong className="text-text">{picked.hints.matchup}</strong>
        </>
      ) : null}
      {picked.hints.map ? (
        <>
          {" "}
          on <strong className="text-text">{picked.hints.map}</strong>
        </>
      ) : null}
. Live parsing requires an account — below is a sample dossier so
      you can see what it looks like first.
    </>
  );
}

function SampleFooter() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-caption text-text-muted">
        This dossier is from a real ladder replay we keep as a sample.
      </p>
      <Link
        href="/sign-up"
        className="inline-flex h-10 min-w-[44px] items-center justify-center gap-2 rounded-lg bg-accent px-4 text-body font-semibold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Parse my replays for real
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}

function ReplayDropPreview({ onActivate }: { onActivate: () => void }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label="Choose a replay file to preview"
      className="group relative flex aspect-[4/3] w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-xl border border-dashed border-accent-cyan/40 bg-bg-elevated/40 p-6 text-center transition-colors hover:border-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(ellipse at center, var(--halo-cyan) 0%, transparent 70%)",
        }}
      />
      <span
        aria-hidden
        className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan motion-safe:transition-transform motion-safe:duration-200 group-hover:scale-110"
      >
        <FileUp className="h-8 w-8" />
      </span>
      <span className="relative space-y-1">
        <span className="block text-h4 font-semibold text-text">
          Pick a replay
        </span>
        <span className="block text-caption text-text-muted">
          .SC2Replay · stays on your device
        </span>
      </span>
    </button>
  );
}

function SampleDossier() {
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-bg-elevated/40 p-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h3 className="text-h3 font-semibold text-text">
            {SAMPLE_DOSSIER.opponent}
          </h3>
          <Badge variant="cyan" size="sm">
            {SAMPLE_DOSSIER.matchup}
          </Badge>
          <Badge variant="neutral" size="sm">
            {SAMPLE_DOSSIER.race}
          </Badge>
          <Badge variant="neutral" size="sm">
            {SAMPLE_DOSSIER.league}
          </Badge>
          <Badge variant="neutral" size="sm">
            {SAMPLE_DOSSIER.mmr} MMR
          </Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-muted">
          <span>
            Map: <strong className="text-text">{SAMPLE_DOSSIER.map}</strong>
          </span>
          <span>
            Head-to-head:{" "}
            <strong className="text-text">
              {SAMPLE_DOSSIER.headToHead.wins}W &mdash;{" "}
              {SAMPLE_DOSSIER.headToHead.losses}L
            </strong>
          </span>
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-caption font-semibold uppercase tracking-wider text-text-muted">
          Build signature
        </h4>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {SAMPLE_DOSSIER.signature.map((row) => (
            <li
              key={row.time}
              className="flex flex-wrap items-center gap-3 px-3 py-2 text-body"
            >
              <span className="w-12 font-mono tabular-nums text-text-dim">
                {row.time}
              </span>
              <span className="flex-1 truncate font-medium text-text">
                {row.label}
              </span>
              <span className="text-caption text-text-muted">{row.tag}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h4 className="mb-2 text-caption font-semibold uppercase tracking-wider text-text-muted">
          Scouting tells
        </h4>
        <ul className="space-y-1.5 text-body text-text-muted">
          {SAMPLE_DOSSIER.tells.map((t) => (
            <li key={t} className="flex items-start gap-2">
              <span
                aria-hidden
                className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-cyan"
              />
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

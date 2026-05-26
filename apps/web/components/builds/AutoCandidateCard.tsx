"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  Layers,
  Pencil,
  Trophy,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { fmtDate, pct1, wrColor } from "@/lib/format";
import {
  coerceRace,
  matchupLabel,
  raceIconName,
  raceTint,
} from "@/lib/race";
import { AutoCandidateRulesPreview } from "./AutoCandidateRulesPreview";
import type { AutoCandidate } from "./types";

export interface AutoCandidateCardProps {
  candidate: AutoCandidate;
  /**
   * Create this candidate as a real custom build. Receives the
   * (possibly user-edited) name so the parent can re-apply it onto
   * the apply-payload before POSTing.
   */
  onCreate: (candidate: AutoCandidate, editedName: string) => Promise<void> | void;
  /** Hide this candidate from the panel for the rest of the session. */
  onDismiss: (candidate: AutoCandidate) => void;
  /** Disable Create while a request is in-flight. */
  creating?: boolean;
}

/**
 * AutoCandidateCard — one row of the auto-discovery panel.
 *
 * Renders the proposed build (matchup chip, gameCount, win-rate pill,
 * cohesion meter, rule preview, sample replays) with an inline-editable
 * name and a "Create build" primary action. Dismiss (X) hides the card
 * locally for the rest of the session.
 *
 * Mobile-first: every interactive control has a ≥44px touch target,
 * the inline-rename input uses a ≥16px font (no iOS zoom-jank), and the
 * sample-replay rows and rule list reflow gracefully under 360px.
 */
export function AutoCandidateCard({
  candidate,
  onCreate,
  onDismiss,
  creating = false,
}: AutoCandidateCardProps) {
  const race = coerceRace(candidate.race);
  const vsRace = coerceRace(candidate.vsRace);
  const tint = raceTint(race);
  const matchup = matchupLabel(race, vsRace);
  const nameId = useId();
  const cohesionId = useId();
  const rulesId = useId();

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(candidate.proposedName);
  const [savedName, setSavedName] = useState(candidate.proposedName);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upstreamNameRef = useRef(candidate.proposedName);

  // If the upstream candidate's proposedName actually changes (e.g. a
  // fresh scan returned a different label), reflect it locally — but
  // only when the user isn't mid-edit, so an in-progress rename never
  // gets clobbered. Comparing against a ref instead of just listening
  // to the prop value prevents this from firing when `editing` flips,
  // which is what would otherwise discard a just-committed rename.
  useEffect(() => {
    if (candidate.proposedName === upstreamNameRef.current) return;
    upstreamNameRef.current = candidate.proposedName;
    if (editing) return;
    setSavedName(candidate.proposedName);
    setDraftName(candidate.proposedName);
  }, [candidate.proposedName, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEditing() {
    setDraftName(savedName);
    setEditing(true);
  }

  function confirmEdit() {
    const trimmed = draftName.trim();
    if (trimmed) setSavedName(trimmed);
    setEditing(false);
  }

  function cancelEdit() {
    setDraftName(savedName);
    setEditing(false);
  }

  function handleCreate() {
    if (creating) return;
    const trimmed = (editing ? draftName : savedName).trim();
    const finalName = trimmed || candidate.proposedName;
    if (editing) {
      setSavedName(finalName);
      setEditing(false);
    }
    void onCreate(candidate, finalName);
  }

  const winRateText = pct1(candidate.winRate);
  const winColor = wrColor(candidate.winRate, candidate.gameCount);
  const cohesionPct = Math.max(0, Math.min(1, candidate.cohesion));
  const cohesionDisplay = `${Math.round(cohesionPct * 100)}%`;

  return (
    <article
      className={[
        "relative overflow-hidden rounded-xl border bg-bg-surface",
        "p-4 sm:p-6",
        tint.border,
      ].join(" ")}
      aria-labelledby={nameId}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="neutral"
              size="sm"
              className={[tint.bg, tint.border, tint.text].join(" ")}
              iconLeft={
                <Icon
                  name={raceIconName(race)}
                  kind="race"
                  size={14}
                  decorative
                />
              }
            >
              {matchup}
            </Badge>
            <Badge variant="neutral" size="sm">
              {candidate.perspective === "opponent" ? "Opponent" : "You"}
            </Badge>
            <Badge
              variant="neutral"
              size="sm"
              iconLeft={<Layers className="h-3 w-3" aria-hidden />}
            >
              matched {candidate.gameCount}{" "}
              {candidate.gameCount === 1 ? "game" : "games"}
            </Badge>
            <span
              className="inline-flex min-h-5 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium tabular-nums"
              style={{
                color: winColor,
                borderColor: `${winColor}66`,
                backgroundColor: `${winColor}1F`,
              }}
              title={`${candidate.gameCount === 1 ? "1 game" : `${candidate.gameCount} games`} — ${winRateText} win rate`}
            >
              <Trophy className="h-3 w-3" aria-hidden />
              {winRateText}
            </span>
          </div>
          <NameField
            id={nameId}
            inputRef={inputRef}
            editing={editing}
            savedName={savedName}
            draftName={draftName}
            onDraftChange={setDraftName}
            onStartEdit={startEditing}
            onConfirm={confirmEdit}
            onCancel={cancelEdit}
          />
        </div>
        <button
          type="button"
          onClick={() => onDismiss(candidate)}
          aria-label={`Dismiss ${savedName || candidate.proposedName}`}
          title="Dismiss for this session"
          className={[
            "inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md",
            "text-text-muted hover:bg-bg-elevated hover:text-text",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          ].join(" ")}
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>

      <div className="mt-4">
        <CohesionMeter id={cohesionId} value={cohesionPct} display={cohesionDisplay} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <section aria-labelledby={rulesId} className="min-w-0">
          <h4
            id={rulesId}
            className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted"
          >
            Opening rules
          </h4>
          <AutoCandidateRulesPreview
            rules={candidate.rules}
            aria-labelledby={rulesId}
          />
        </section>
        <SampleReplays games={candidate.sampleGames} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          onClick={handleCreate}
          loading={creating}
          iconLeft={
            creating ? null : <Check className="h-4 w-4" aria-hidden />
          }
        >
          Create build
        </Button>
        <span className="text-caption text-text-dim">
          Promotes to a normal custom build — edit and publish as usual.
        </span>
      </div>
    </article>
  );
}

function NameField({
  id,
  inputRef,
  editing,
  savedName,
  draftName,
  onDraftChange,
  onStartEdit,
  onConfirm,
  onCancel,
}: {
  id: string;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  editing: boolean;
  savedName: string;
  draftName: string;
  onDraftChange: (next: string) => void;
  onStartEdit: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={draftName}
          maxLength={120}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onConfirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          aria-label="Edit build name"
          className={[
            "min-w-0 flex-1 rounded-lg border border-accent bg-bg-elevated px-3 py-2",
            "text-text font-semibold leading-tight tracking-tight",
            "focus:outline-none focus:ring-2 focus:ring-accent/40",
          ].join(" ")}
          style={{ fontSize: 16 }}
        />
        <button
          type="button"
          onClick={onConfirm}
          aria-label="Confirm name"
          className={[
            "inline-flex h-11 w-11 items-center justify-center rounded-md",
            "bg-accent text-white hover:bg-accent-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          ].join(" ")}
        >
          <Check className="h-5 w-5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel rename"
          className={[
            "inline-flex h-11 w-11 items-center justify-center rounded-md",
            "border border-border text-text-muted hover:bg-bg-elevated hover:text-text",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          ].join(" ")}
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <h3
        id={id}
        className="break-words text-h4 font-semibold leading-tight text-text"
        title={savedName}
      >
        {savedName || "Untitled candidate"}
      </h3>
      <button
        type="button"
        onClick={onStartEdit}
        aria-label="Rename candidate"
        title="Rename — your text becomes the build name when you click Create."
        className={[
          "inline-flex h-11 min-w-[44px] items-center justify-center gap-1 rounded-md px-2",
          "text-caption text-text-muted hover:bg-bg-elevated hover:text-text",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        ].join(" ")}
      >
        <Pencil className="h-4 w-4" aria-hidden />
        <span className="sr-only sm:not-sr-only">Rename</span>
      </button>
    </div>
  );
}

function CohesionMeter({
  id,
  value,
  display,
}: {
  id: string;
  value: number;
  display: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      title="Cohesion — how tightly these games match each other. Higher means the openings are more uniform."
    >
      <label
        htmlFor={id}
        className="text-[10px] font-semibold uppercase tracking-wider text-text-muted"
      >
        Cohesion
      </label>
      <div
        id={id}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-label={`Group cohesion ${display}`}
        className="relative h-1.5 min-w-[120px] flex-1 overflow-hidden rounded-full bg-bg-elevated"
      >
        <div
          className="h-full rounded-full bg-accent-cyan motion-reduce:transition-none transition-[width] duration-300"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </div>
      <span className="font-mono tabular-nums text-caption text-text-muted">
        {display}
      </span>
    </div>
  );
}

function SampleReplays({
  games,
}: {
  games: AutoCandidate["sampleGames"];
}) {
  if (!games || games.length === 0) {
    return (
      <section aria-label="Sample games" className="min-w-0">
        <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          Sample games
        </h4>
        <p className="text-caption text-text-dim">
          No sample games attached.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Sample games" className="min-w-0">
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        Sample games ({games.length})
      </h4>
      <ul role="list" className="space-y-1.5">
        {games.map((g) => (
          <SampleReplayRow key={g.gameId} game={g} />
        ))}
      </ul>
    </section>
  );
}

function SampleReplayRow({
  game,
}: {
  game: AutoCandidate["sampleGames"][number];
}) {
  const result = (game.result || "").toLowerCase();
  const isWin = result === "win" || result === "victory";
  const isLoss = result === "loss" || result === "defeat";
  return (
    <li className="flex min-h-[36px] flex-wrap items-center gap-2 rounded-md border border-border bg-bg-elevated/50 px-2 py-1 text-caption">
      <span
        className={[
          "inline-flex h-5 min-w-[28px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold",
          isWin
            ? "bg-success/15 text-success"
            : isLoss
              ? "bg-danger/15 text-danger"
              : "bg-bg-subtle text-text-muted",
        ].join(" ")}
        aria-label={
          isWin ? "Win" : isLoss ? "Loss" : `Result: ${game.result || "unknown"}`
        }
      >
        {isWin ? "W" : isLoss ? "L" : "?"}
      </span>
      <span className="min-w-0 flex-1 truncate text-text" title={game.map || "Unknown map"}>
        {game.map || "Unknown map"}
      </span>
      <span className="font-mono tabular-nums text-[11px] text-text-dim">
        {game.date ? fmtDate(game.date) : "—"}
      </span>
      <span
        className="hidden text-text-dim sm:inline"
        aria-hidden
        title="Game detail opens after this candidate is created — once it's a real build you can open its dossier."
      >
        <ExternalLink className="h-3 w-3 opacity-50" />
      </span>
    </li>
  );
}


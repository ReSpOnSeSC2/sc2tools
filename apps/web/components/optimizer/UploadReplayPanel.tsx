"use client";

/**
 * "Upload replay" source panel: drop any .SC2Replay and adapt either
 * player's build. Parsing reuses the public preview endpoint
 * (POST /v1/public/preview-replay — raw octet-stream in, parsed
 * dossier out, nothing persisted), so it works for replays that
 * aren't in the user's library: a pro's VOD replay, a practice
 * partner's file, or a game from another account.
 */
import { useMemo, useRef, useState, type DragEvent } from "react";
import { ArrowRightLeft, FileUp } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { API_BASE } from "@/lib/clientApi";
import { buildLogToEvents } from "@/lib/build-events";
import { coerceSimRace, type BuildSource } from "./buildSource";

interface PreviewPlayer {
  name: string;
  race: string;
  result: string;
  handle: string | null;
  build_log: string[];
  mmr?: number;
}

interface PreviewDossier {
  ok: true;
  game_id: string;
  map: string;
  duration_sec: number;
  date: string;
  players: [PreviewPlayer, PreviewPlayer];
}

const MAX_BYTES = 5 * 1024 * 1024; // matches the API limit

const FRIENDLY_ERRORS: Record<string, string> = {
  empty_body: "That file looked empty — pick another replay?",
  not_a_replay:
    "That doesn't look like a .SC2Replay file. Pick a real replay from your StarCraft II folder.",
  no_two_humans:
    "Only 1v1 replays with two human players can be adapted (no vs-AI / co-op).",
  ai_game: "Only 1v1 replays vs another human can be adapted, not vs-AI.",
  parser_no_output:
    "The parser ran but returned nothing. Try a different replay.",
  python_error: "The parser hit an error on this replay. Try a different one.",
  parse_failed: "Couldn't parse that replay. Try a different one.",
  replay_too_new:
    "This replay comes from an SC2 patch newer than the cloud parser can read. Games parsed by the desktop agent (My games tab) aren't affected.",
  extract_failed:
    "We loaded the replay but couldn't walk its event stream. Try a different replay.",
  file_not_found: "We lost track of the upload before parsing it. Try again.",
  preview_timeout: "Parsing timed out on this replay. Try again in a moment.",
  parser_overflow: "This replay is too large for the cloud parser.",
  preview_unavailable:
    "The replay parser is temporarily offline. Try again in a few minutes.",
  rate_limited: "Easy! Wait a minute, then upload another replay.",
  too_large: "That file is bigger than the 5 MB upload limit.",
};

function friendlyError(code: string, message: string): string {
  return (
    FRIENDLY_ERRORS[code] ||
    message ||
    "Couldn't parse that replay. Try a different one."
  );
}

export function UploadReplayPanel({
  onAdapt,
}: {
  onAdapt: (source: BuildSource) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const [dossier, setDossier] = useState<PreviewDossier | null>(null);
  const [perspective, setPerspective] = useState<0 | 1>(0);
  const [error, setError] = useState<string | null>(null);

  const me = dossier?.players[perspective] ?? null;
  const opp = dossier?.players[perspective === 0 ? 1 : 0] ?? null;

  const events = useMemo(
    () => (me ? buildLogToEvents(me.build_log, me.race) : []),
    [me],
  );
  const meRace = coerceSimRace(me?.race);

  async function parse(file: File | null) {
    if (!file || busy) return;
    setFilename(file.name);
    setDossier(null);
    setPerspective(0);
    setError(null);
    if (file.size === 0) {
      setError(friendlyError("empty_body", ""));
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(friendlyError("too_large", ""));
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(`${API_BASE}/v1/public/preview-replay`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: buf,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.ok !== true) {
        const code = json?.error?.code || `http_${res.status}`;
        setError(friendlyError(code, json?.error?.message || ""));
        return;
      }
      setDossier(json as PreviewDossier);
    } catch (err: unknown) {
      setError(
        err instanceof Error && err.message
          ? `Upload failed: ${err.message}`
          : "Upload failed — check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    void parse(e.dataTransfer.files?.[0] ?? null);
  };

  const handleAdapt = () => {
    if (!dossier || !me || !opp) return;
    if (!meRace) {
      setError(
        `${me.name} played a race the simulator can't model — pick the other player.`,
      );
      return;
    }
    if (events.length === 0) {
      setError(
        `No build-order events were found for ${me.name} in this replay.`,
      );
      return;
    }
    setError(null);
    onAdapt({
      type: "replay",
      id: `upload:${dossier.game_id}`,
      name: `${me.name} on ${dossier.map}`,
      race: meRace,
      vsRace: coerceSimRace(opp.race) ?? undefined,
      events,
    });
  };

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload a .SC2Replay file"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={[
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          dragOver
            ? "border-accent bg-accent/10"
            : "border-line/40 bg-bg-surface hover:border-line/70",
        ].join(" ")}
      >
        <FileUp aria-hidden className="h-6 w-6 text-text-muted" />
        <p className="text-body font-medium text-text">
          {busy ? "Parsing replay…" : "Drop a .SC2Replay here"}
        </p>
        <p className="text-caption text-text-dim">
          {filename ??
            "or click to browse — parsed in the cloud, nothing is saved"}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".SC2Replay"
          className="hidden"
          onChange={(e) => {
            void parse(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
      </div>

      {dossier ? (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-caption font-medium text-text">
              Whose build should be adapted?
            </span>
            <span className="text-caption text-text-dim">{dossier.map}</span>
          </div>
          <div
            className="grid gap-1.5 sm:grid-cols-2"
            role="radiogroup"
            aria-label="Player to adapt"
          >
            {dossier.players.map((player, index) => {
              const isSelected = perspective === index;
              const race = coerceSimRace(player.race);
              return (
                <button
                  key={`${player.name}-${index}`}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setPerspective(index as 0 | 1)}
                  className={[
                    "flex items-center gap-2 rounded-lg border-2 p-3 text-left transition-colors",
                    isSelected
                      ? "border-line bg-accent/10 shadow-hard"
                      : "border-line/25 bg-bg-surface hover:border-line/60",
                  ].join(" ")}
                >
                  {race ? (
                    <Icon
                      name={race.toLowerCase()}
                      kind="race"
                      size="sm"
                      decorative
                    />
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold text-text">
                      {player.name}
                    </span>
                    <span className="block text-caption text-text-dim">
                      {player.race}
                      {player.mmr ? ` · ${player.mmr} MMR` : ""}
                    </span>
                  </span>
                  {player.result === "Win" || player.result === "Victory" ? (
                    <Badge variant="success" size="sm">
                      Win
                    </Badge>
                  ) : null}
                </button>
              );
            })}
          </div>
          <Button
            onClick={handleAdapt}
            iconLeft={<ArrowRightLeft className="h-4 w-4" />}
          >
            Adapt {me?.name ?? "this player"}&apos;s build
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

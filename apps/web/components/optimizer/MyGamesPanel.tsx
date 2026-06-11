"use client";

/**
 * "My games" source panel: every parsed game in the user's replay
 * library, newest first. Pick one and Adapt — the panel pulls that
 * game's build-order events from /v1/games/:id/build-order and hands
 * them (with the game's own race + matchup) to the orchestrator.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRightLeft } from "lucide-react";
import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { apiCall, useApi } from "@/lib/clientApi";
import type { BuildOrderEvent } from "@/lib/build-events";
import { coerceSimRace, type BuildSource } from "./buildSource";

interface GameListItem {
  gameId: string;
  date?: string;
  result?: "Victory" | "Defeat" | "Tie" | string;
  myRace?: string;
  myBuild?: string;
  map?: string;
  durationSec?: number;
  opponent?: { displayName?: string; race?: string };
}

interface GamesListResp {
  items: GameListItem[];
  nextBefore: string | null;
}

interface BuildOrderResp {
  ok: boolean;
  my_race: string | null;
  opp_race: string | null;
  events: BuildOrderEvent[];
  early_events: BuildOrderEvent[];
  my_status?: "ok" | "empty" | "not_extracted";
}

const PAGE_SIZE = 50;

function raceLetter(raw: string | undefined): string {
  const r = coerceSimRace(raw);
  return r ? r.charAt(0) : "?";
}

function formatDuration(sec: number | undefined): string | null {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return null;
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function resultBadge(result: string | undefined) {
  if (result === "Victory") {
    return (
      <Badge variant="success" size="sm">
        Win
      </Badge>
    );
  }
  if (result === "Defeat") {
    return (
      <Badge variant="danger" size="sm">
        Loss
      </Badge>
    );
  }
  if (result === "Tie") {
    return (
      <Badge variant="neutral" size="sm">
        Tie
      </Badge>
    );
  }
  return null;
}

export function MyGamesPanel({
  onAdapt,
}: {
  onAdapt: (source: BuildSource) => void;
}) {
  const { getToken } = useAuth();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [extraPages, setExtraPages] = useState<GamesListResp[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [adapting, setAdapting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: firstPage, isLoading } = useApi<GamesListResp>(
    `/v1/games?limit=${PAGE_SIZE}`,
    { revalidateOnFocus: false },
  );

  const games = useMemo(() => {
    const all = [
      ...(firstPage?.items ?? []),
      ...extraPages.flatMap((p) => p.items),
    ];
    // Re-uploads can repeat across pages — keep the first occurrence.
    const seen = new Set<string>();
    return all.filter((g) => {
      if (!g?.gameId || seen.has(g.gameId)) return false;
      seen.add(g.gameId);
      return true;
    });
  }, [firstPage, extraPages]);

  const nextBefore =
    extraPages.length > 0
      ? extraPages[extraPages.length - 1].nextBefore
      : (firstPage?.nextBefore ?? null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return games;
    return games.filter((g) => {
      const matchup = `${raceLetter(g.myRace)}v${raceLetter(g.opponent?.race)}`;
      return [g.map, g.myBuild, g.opponent?.displayName, matchup, g.result]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [games, query]);

  const selected = games.find((g) => g.gameId === selectedId) ?? null;

  const handleLoadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await apiCall<GamesListResp>(
        getToken,
        `/v1/games?limit=${PAGE_SIZE}&before=${encodeURIComponent(nextBefore)}`,
      );
      setExtraPages((pages) => [...pages, page]);
    } catch (err: unknown) {
      setError(
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Couldn't load more games.",
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const handleAdapt = async () => {
    if (!selected || adapting) return;
    setAdapting(true);
    setError(null);
    try {
      const resp = await apiCall<BuildOrderResp>(
        getToken,
        `/v1/games/${encodeURIComponent(selected.gameId)}/build-order`,
      );
      const events =
        resp.events?.length > 0 ? resp.events : (resp.early_events ?? []);
      if (resp.my_status === "not_extracted" || events.length === 0) {
        throw new Error(
          "This game has no extracted build-order events yet — open it in the analyzer once, or pick another game.",
        );
      }
      const race = coerceSimRace(resp.my_race ?? selected.myRace);
      if (!race) {
        throw new Error(
          "Couldn't determine your race in this game, so it can't be simulated.",
        );
      }
      const matchup = `${race.charAt(0)}v${raceLetter(
        resp.opp_race ?? selected.opponent?.race,
      )}`;
      const name =
        selected.myBuild?.trim() ||
        `${matchup} on ${selected.map ?? "unknown map"}`;
      onAdapt({
        type: "replay",
        id: selected.gameId,
        name,
        race,
        vsRace:
          coerceSimRace(resp.opp_race ?? selected.opponent?.race) ?? undefined,
        events,
      });
    } catch (err: unknown) {
      setError(
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Couldn't load that game's build order.",
      );
    } finally {
      setAdapting(false);
    }
  };

  return (
    <div className="space-y-3">
      <SignedIn>
        <Input
          inputSize="sm"
          type="search"
          placeholder="Search by map, opponent, build, or matchup…"
          aria-label="Search my games"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {isLoading ? (
          <EmptyState title="Loading your games…" sub="Newest first." />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={games.length === 0 ? "No parsed games yet" : "No matches"}
            sub={
              games.length === 0
                ? "Games uploaded by the desktop agent appear here automatically."
                : "Try a different search."
            }
          />
        ) : (
          <ul
            className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1"
            role="radiogroup"
            aria-label="My games"
          >
            {filtered.map((game) => {
              const isSelected = selectedId === game.gameId;
              const matchup = `${raceLetter(game.myRace)}v${raceLetter(
                game.opponent?.race,
              )}`;
              const duration = formatDuration(game.durationSec);
              return (
                <li key={game.gameId}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedId(game.gameId)}
                    className={[
                      "w-full rounded-lg border-2 p-3 text-left transition-colors",
                      isSelected
                        ? "border-line bg-accent/10 shadow-hard"
                        : "border-line/25 bg-bg-surface hover:border-line/60",
                    ].join(" ")}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body font-semibold text-text">
                        {matchup} · {game.map ?? "Unknown map"}
                      </span>
                      {resultBadge(game.result)}
                      {duration ? (
                        <span className="font-mono text-caption text-text-dim">
                          {duration}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-caption text-text-muted">
                      {formatDate(game.date)}
                      {game.opponent?.displayName
                        ? ` · vs ${game.opponent.displayName}`
                        : ""}
                      {game.myBuild ? ` · ${game.myBuild}` : ""}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {nextBefore && !query.trim() ? (
          <Button
            variant="ghost"
            size="sm"
            loading={loadingMore}
            onClick={handleLoadMore}
          >
            Load older games
          </Button>
        ) : null}
        <Button
          disabled={!selected}
          loading={adapting}
          onClick={handleAdapt}
          iconLeft={<ArrowRightLeft className="h-4 w-4" />}
        >
          Adapt this game&apos;s build
        </Button>
        {error ? (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        ) : null}
      </SignedIn>
      <SignedOut>
        <EmptyState
          title="Sign in to use your replay library"
          sub="Your parsed games live in your account. You can still adapt a replay without signing in — use the Upload replay tab."
        />
        <p className="text-caption text-text-dim">
          New here?{" "}
          <Link href="/" className="text-accent hover:underline">
            Learn how the desktop agent parses your games.
          </Link>
        </p>
      </SignedOut>
    </div>
  );
}

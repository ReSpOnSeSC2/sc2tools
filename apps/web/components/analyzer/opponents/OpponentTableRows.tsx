"use client";

import { memo, type MouseEvent, type ReactNode } from "react";
import { OpponentDetailCells } from "./OpponentDetailColumns";
import Link from "next/link";
import { ChevronDown, ChevronRight, CornerDownRight, ExternalLink, StickyNote } from "lucide-react";
import { fmtAgo, fmtMmr, pct1, wrColor } from "@/lib/format";
import { pickPulseLabel, sc2pulseCharacterUrl } from "@/lib/sc2pulse";
import type { OpponentGroup } from "@/lib/opponentGroups";
import { PlayerChannelLinks, type PlayerChannels } from "../PlayerChannelLinks";
import { usePlayerChannels } from "../usePlayerChannels";
import { MmrImpactCells } from "../OpponentMmrImpact";
import { RevealedChip } from "../RevealedChip";
import { opponentDossierHref } from "../tabs";
import { type Opp, type OpenOpponent, notePreview } from "./types";
import type { OpponentColumns } from "@/lib/opponentPresentation";
import { opponentRegion } from "@/lib/opponentPresentation";
import { OpponentRace } from "./OpponentRace";

function rowCanOpen(event: MouseEvent<HTMLTableRowElement>) {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
    && !(event.target as HTMLElement).closest("a,button,input,select,textarea") && !window.getSelection()?.toString();
}

export const OpponentRow = memo(function OpponentRow({ row: o, expanded, onToggle, onOpen, onPrefetch, channelsFor, columns, star }: {
  row: OpponentGroup<Opp>; expanded: boolean; onToggle: (id: string) => void;
  onOpen: OpenOpponent; channelsFor: ReturnType<typeof usePlayerChannels>;
  onPrefetch: (id: string | null) => void;
  columns: OpponentColumns; star?: ReactNode;
}) {
  return (
                    <tr
                      onClick={(event) => { if (rowCanOpen(event)) onOpen(o.pulseId); }}
                      onPointerEnter={() => onPrefetch(o.pulseId)} onPointerLeave={() => onPrefetch(null)}
                      className="group cursor-pointer border-t border-border hover:bg-accent/10"
                    >
                      <td
                        className="sticky left-0 z-10 bg-bg-surface px-2 py-1 text-text group-hover:text-accent"
                        title={groupRowTitle(o)}
                      >
                        <span className="flex min-w-0 items-center gap-1">
                          {star}
                          <OpponentLink opponent={o} onOpen={onOpen} className="min-w-[4rem] max-w-[12rem] truncate hover:underline">
                            {o.name || (
                              <span className="italic text-text-dim">unnamed</span>
                            )}
                          </OpponentLink>
                          <RevealedChip
                            name={o.revealedName}
                            displayedName={o.name}
                            confirmed={!!o.globalIdentity}
                          />
                          {opponentRegion(o) ? <span className="text-micro text-text-dim">{opponentRegion(o)}</span> : null}
                          <PlayerChannelLinks channels={channelsFor(o) || o.identities.map(channelsFor).find(Boolean)} playerName={o.revealedName || o.name} compact />
                          <NotePreview previews={o.identities.map(notePreview).filter(Boolean)} />
                          {o.groupSize > 1 ? (
                            <AliasChip
                              group={o}
                              expanded={expanded}
                              onToggle={() => onToggle(o.pulseId)}
                            />
                          ) : null}
                        </span>
                      </td>
                      <td className="px-2 py-1"><OpponentRace row={o} /></td>
                      {columns.pulseId ? <PulseIdCell opp={o} /> : null}
                      <td className="px-2 py-1 text-right tabular-nums text-success">
                        {o.wins}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-danger">
                        {o.losses}
                      </td>
                      <td
                        className="px-2 py-1 text-right tabular-nums"
                        style={{ color: wrColor(o.winRate, o.games) }}
                      >
                        {pct1(o.winRate)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-text-muted">
                        {o.games}
                      </td>
                      {columns.mmr ? <td
                        className="px-2 py-1 text-right tabular-nums text-text-muted"
                        title={
                          typeof o.mmr === "number"
                            ? "MMR from the most recent game you played against this opponent"
                            : "No MMR on record yet"
                        }
                      >
                        {fmtMmr(o.mmr)}
                      </td> : null}
                      <MmrImpactCells opponent={o} columns={columns} />
                      <OpponentDetailCells row={o} columns={columns} />
                      <td className="px-2 py-1 text-right text-xs text-text-dim">
                        {o.lastPlayed ? <time dateTime={o.lastPlayed} title={new Date(o.lastPlayed).toLocaleString()}>{fmtAgo(o.lastPlayed)}</time> : "—"}
                      </td>
                      <td className="px-1 py-1 text-right text-text-dim group-hover:text-accent">
                        <OpponentOpenButton opponent={o} onOpen={onOpen} />
                      </td>
                    </tr>
  );
});

/** Hover title for a (possibly grouped) opponent row. */
function groupRowTitle(o: OpponentGroup<Opp>): string {
  const base = o.revealedName
    ? `${o.name || "unnamed"} · revealed as ${o.revealedName}`
    : o.name || "";
  if (o.aliasNames.length === 0) return base;
  return `${base} · also plays as ${o.aliasNames.join(", ")}`;
}

/**
 * "+N names" disclosure chip on a grouped row. SC2Pulse says these
 * names are the same player; the chip both announces that and expands
 * the per-name breakdown underneath. stopPropagation so toggling
 * never triggers the row's deep-dive navigation.
 */
export function AliasChip({
  group,
  expanded,
  onToggle,
}: {
  group: OpponentGroup<Opp>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const extra = group.groupSize - 1;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} the ${group.groupSize} names this player uses`}
      title={`Same player${group.globalIdentity ? " · confirmed identity" : " on SC2Pulse"} · also plays as ${group.aliasNames.join(", ")}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="inline-flex min-h-[44px] flex-shrink-0 items-center gap-0.5 rounded-full bg-accent/15 px-2 py-0.5 text-micro font-semibold text-accent transition-colors hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg"
    >
      +{extra} {extra === 1 ? "name" : "names"}
      <Chevron className="h-3 w-3" aria-hidden />
    </button>
  );
}

/**
 * One identity inside an expanded group — the per-name W/L/games
 * breakdown. Clickable like a main row, opening THAT identity's deep
 * dive (each name keeps its own game history and profile).
 */
export function IdentityRow({
  identity,
  channels,
  onOpen,
  onPrefetch,
  columns,
}: {
  identity: Opp;
  channels?: PlayerChannels;
  onOpen: OpenOpponent;
  onPrefetch: (id: string | null) => void;
  columns: OpponentColumns;
}) {
  const revealedName = identity.globalIdentity?.displayName.trim() || identity.revealedName;
  return (
    <tr
      onClick={(event) => { if (rowCanOpen(event)) onOpen(identity.pulseId); }}
      onPointerEnter={() => onPrefetch(identity.pulseId)} onPointerLeave={() => onPrefetch(null)}
      className="group cursor-pointer border-t border-border/60 bg-bg-elevated/40 hover:bg-accent/10"
    >
      <td
        className="sticky left-0 z-10 bg-bg-elevated py-1 pl-5 pr-2 text-text-muted group-hover:text-accent"
        title={identity.name || ""}
      >
        <span className="flex min-w-0 items-center gap-1">
          <CornerDownRight
            className="h-3 w-3 flex-shrink-0 text-text-dim"
            aria-hidden
          />
          <OpponentLink opponent={identity} onOpen={onOpen} className="min-w-[4rem] max-w-[12rem] truncate hover:underline">
            {identity.name || (
              <span className="italic text-text-dim">unnamed</span>
            )}
          </OpponentLink>
          <RevealedChip name={revealedName} displayedName={identity.name} confirmed={!!identity.globalIdentity} />
          <PlayerChannelLinks channels={channels} playerName={revealedName || identity.name} compact />
          <NotePreview previews={[notePreview(identity)].filter(Boolean)} />
        </span>
      </td>
      <td className="px-2 py-1"><OpponentRace row={identity} /></td>
      {columns.pulseId ? <PulseIdCell opp={identity} /> : null}
      <td className="px-2 py-1 text-right tabular-nums text-success">
        {identity.wins}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-danger">
        {identity.losses}
      </td>
      <td
        className="px-2 py-1 text-right tabular-nums"
        style={{ color: wrColor(identity.winRate, identity.games) }}
      >
        {pct1(identity.winRate)}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-text-muted">
        {identity.games}
      </td>
      {columns.mmr ? <td className="px-2 py-1 text-right tabular-nums text-text-muted">
        {fmtMmr(identity.mmr)}
      </td> : null}
      <MmrImpactCells opponent={identity} columns={columns} />
      <OpponentDetailCells row={identity} columns={columns} />
      <td className="px-2 py-1 text-right text-xs text-text-dim">
        {identity.lastPlayed ? <time dateTime={identity.lastPlayed} title={new Date(identity.lastPlayed).toLocaleString()}>{fmtAgo(identity.lastPlayed)}</time> : "—"}
      </td>
      <td className="px-1 py-1 text-right text-text-dim group-hover:text-accent">
        <OpponentOpenButton opponent={identity} onOpen={onOpen} />
      </td>
    </tr>
  );
}

function OpponentOpenButton({
  opponent,
  onOpen,
}: {
  opponent: Pick<Opp, "pulseId" | "name">;
  onOpen: OpenOpponent;
}) {
  const name = opponent.name || "unnamed opponent";
  return (
    <OpponentLink opponent={opponent} onOpen={onOpen}
      aria-label={`Open dossier for ${name}`}
      className="inline-flex h-11 w-11 items-center justify-center rounded text-current hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span aria-hidden>→</span>
    </OpponentLink>
  );
}

export function OpponentLink({ opponent, onOpen, children, ...props }: { opponent: Pick<Opp, "pulseId" | "name">; onOpen: OpenOpponent; children: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
  return <Link href={opponentDossierHref(opponent.pulseId)} prefetch={false} {...props} onClick={(event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.stopPropagation(); if (onOpen(opponent.pulseId, true)) event.preventDefault();
  }}>{children}</Link>;
}

export function NotePreview({ previews }: { previews: string[] }) {
  if (!previews.length) return null;
  return <span className="group/note relative inline-flex shrink-0 items-center gap-1">
    <button type="button" aria-label={`Scouting note: ${previews[0]}`} title={previews[0]} onClick={(event) => event.stopPropagation()} className="flex h-11 w-11 items-center justify-center rounded text-accent focus-visible:ring-2 focus-visible:ring-accent"><StickyNote className="h-3.5 w-3.5" aria-hidden /></button>
    {previews.length > 1 ? <span className="text-micro text-text-dim">+{previews.length - 1} more</span> : null}
    <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-20 hidden w-64 whitespace-normal rounded-lg border border-line bg-bg-elevated p-3 text-caption text-text shadow-hard group-hover/note:block group-focus-within/note:block">{previews[0]}</span>
  </span>;
}

/**
 * The "Pulse ID" cell. When the agent has resolved the opponent's
 * canonical SC2Pulse character id (e.g. "994428"), show it as a link
 * to sc2pulse.nephest.com. Otherwise, show the raw toon_handle in dim
 * mono with a "(toon)" hint so the user can tell at a glance that
 * resolution hasn't happened yet (e.g. SC2Pulse was down during
 * the first ingest, or the opponent isn't ranked yet).
 */
function PulseIdCell({ opp }: { opp: Opp }) {
  const label = pickPulseLabel(opp);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (!label) {
    return (
      <td className="px-2 py-1 text-xs text-text-dim">—</td>
    );
  }
  if (label.isPulseCharacterId) {
    return (
      <td
        className="truncate px-2 py-1 font-mono text-xs"
        title={opp.toonHandle || opp.pulseId}
      >
        <a
          href={sc2pulseCharacterUrl(label.value)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={stop}
          className="inline-flex items-center gap-1 text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {label.value}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </td>
    );
  }
  return (
    <td
      className="truncate px-2 py-1 font-mono text-xs text-text-dim"
      title={`${label.value} · sc2pulse character id not resolved yet`}
    >
      {label.value}
      <span className="ml-1 text-micro uppercase tracking-wider text-text-muted">
        toon
      </span>
    </td>
  );
}

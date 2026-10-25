"use client";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { ExternalLink, Users } from "lucide-react";
import type { MergedIdentity } from "@/lib/opponentGroups";
import { OPPONENT_PROFILE_MIN_PLAYERS } from "@/lib/communityOpponent";
import { pickPulseLabel, sc2pulseCharacterUrl } from "@/lib/sc2pulse";

/**
 * Disclosure chip rendered in the profile header when the opponent's
 * games were merged across more than one toon_handle (the rare
 * Battle.net rebind case where SC2Pulse keeps the same canonical
 * character id but the in-replay toon rotates). The chip's
 * native ``title`` attribute lists every merged toon so the user
 * can hover/long-press for the full set without us shipping a
 * dedicated tooltip primitive. Hidden entirely on the single-toon
 * common case so existing profiles look identical.
 *
 * Touch-target: the chip itself is non-interactive (no link / no
 * tap action), so the 44 px minimum-touch rule from the rest of the
 * SPA doesn't apply — it's an inline disclosure, sized to read
 * comfortably alongside the h1 on both mobile and desktop without
 * crowding the stat strip.
 */
export function MergedToonsChip({
  handles,
}: {
  handles?: string[] | null;
}) {
  if (!handles || handles.length <= 1) return null;
  const summary = `Merged across ${handles.length} toons`;
  // Native title on a span — browsers / screen readers surface it
  // as the accessible description. Mobile users get the same on
  // long-press in most browsers; we don't need a custom tooltip.
  return (
    <span
      role="note"
      aria-label={`${summary}: ${handles.join(", ")}`}
      title={`Same SC2Pulse character across:\n${handles.join("\n")}`}
      className="inline-flex items-center rounded-full border border-accent-cyan/40 bg-accent-cyan/10 px-2 py-0.5 text-micro font-medium uppercase tracking-wider text-accent-cyan"
    >
      {summary}
    </span>
  );
}

/**
 * Per-name breakdown for a merged player profile: every name SC2Pulse
 * links to this player, with its own W-L, so "all their games on one
 * page" stays auditable per name. The stats on this page already span
 * all of them — this line is disclosure, not navigation. Renders
 * nothing on single-identity profiles.
 */
export function MergedIdentitiesLine({
  identities,
  mainName,
}: {
  identities?: MergedIdentity[] | null;
  mainName?: string;
}) {
  if (!identities || identities.length <= 1) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span
        className="text-micro uppercase tracking-wider text-text-dim"
        title="SC2Pulse links these names to the same player — this page merges all of their games"
      >
        Plays as
      </span>
      {identities.map((identity) => {
        const label = identity.name || "unnamed";
        const isMain = !!mainName && identity.name === mainName;
        return (
          <span
            key={identity.pulseId}
            title={`${label} · ${identity.wins}-${identity.losses} vs you`}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption ${
              isMain
                ? "border-accent/40 bg-accent/10 text-text"
                : "border-border bg-bg-elevated text-text-muted"
            }`}
          >
            <span className="max-w-[9rem] truncate">{label}</span>
            <span className="tabular-nums text-micro text-text-dim">
              {identity.wins}-{identity.losses}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Pulse identity line in the profile header. Mirrors the table-cell
 * treatment in OpponentsTab: when we have a real SC2Pulse character
 * id, link out to nephest with the resolved id; otherwise fall back to
 * the toon_handle (the value from the user's replay folder name) and
 * label it accordingly.
 */
const PUBLIC_PROFILE_TIP = `Anyone can see this opponent's public profile: games from every SC2 Tools player who has faced them, combined. It only exists once at least ${OPPONENT_PROFILE_MIN_PLAYERS} different players have, and it never shows names or battle tags.`;

/** Link to /community/opponents/<id>, shown only once that profile exists. */
export function PublicProfileLink({ href }: { href: string }) {
  return (
    <>
      <Link
        href={href}
        title={PUBLIC_PROFILE_TIP}
        aria-describedby="public-profile-tip"
        className={buttonClassName({ variant: "ghost", className: "mt-1" })}
      >
        <Users className="h-3.5 w-3.5" aria-hidden />
        Community profile
      </Link>
      <span id="public-profile-tip" className="sr-only">
        {PUBLIC_PROFILE_TIP}
      </span>
    </>
  );
}

export function ProfilePulseLine({
  pulseCharacterId,
  toonHandle,
  pulseId,
  recordedAccount = false,
}: {
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  pulseId: string;
  recordedAccount?: boolean;
}) {
  const label = pickPulseLabel({ pulseCharacterId, toonHandle, pulseId });
  if (!label) {
    return (
      <div className="font-mono text-caption text-text-dim">Pulse ID —</div>
    );
  }
  if (label.isPulseCharacterId) {
    return (
      <div className="flex flex-wrap items-center gap-2 font-mono text-caption text-text-dim">
        <span>{recordedAccount ? "Played account · Pulse ID" : "Pulse ID"}</span>
        <a
          href={sc2pulseCharacterUrl(label.value)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          {label.value}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
        {toonHandle ? (
          <span className="text-text-muted">· toon {toonHandle}</span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="font-mono text-caption text-text-dim">
      Toon {label.value}
      <span className="ml-2 text-micro uppercase tracking-wider text-text-muted">
        sc2pulse id not resolved yet
      </span>
    </div>
  );
}


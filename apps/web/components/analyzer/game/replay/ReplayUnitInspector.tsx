"use client";

import { Crosshair, SkipBack, SkipForward, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatClock } from "@/lib/replayHud";
import type { InspectedEntity } from "@/lib/replayInspect";
import { getIconPath } from "@/lib/sc2-icons";

const BUTTON_CLASS =
  "inline-flex min-h-10 flex-1 items-center justify-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 text-micro font-semibold text-white hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The glass details card for the unit or structure picked on the map:
 * what it is, whose it is, when it arrived and left, how long it lived
 * and how often it fired, with jumps to its birth and death and a
 * camera follow. Escape releases a follow, then closes the card.
 */
export function ReplayUnitInspector({
  info,
  ownerLabel,
  following,
  onJump,
  onFollow,
  onClose,
}: {
  info: InspectedEntity;
  ownerLabel: string;
  following: boolean;
  onJump: (time: number) => void;
  onFollow: (follow: boolean) => void;
  onClose: () => void;
}) {
  const kind = info.ref.kind === "building" ? "building" : "unit";
  const icon = getIconPath(info.name, kind);
  const died = info.died;
  // Escape from a button inside the card: a native listener, so the
  // card stays a plain labelled region rather than a widget.
  const ref = useRef<HTMLElement | null>(null);
  const escapeRef = useRef(() => {});
  escapeRef.current = () => (following ? onFollow(false) : onClose());
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      escapeRef.current();
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, []);
  return (
    <section
      ref={ref}
      aria-label={`${info.name} details`}
      data-testid="replay-unit-inspector"
      className="pointer-events-auto w-60 max-w-full rounded-lg border border-white/15 bg-black/75 p-2.5 text-white shadow-card backdrop-blur-sm"
    >
      <div className="flex items-start gap-2">
        {icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={icon} alt="" aria-hidden className="h-8 w-8 shrink-0 rounded" />
        ) : null}
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="truncate text-caption font-semibold leading-tight">{info.name}</p>
          <p className="truncate text-micro text-white/70">
            {ownerLabel} · {kind}{info.visible ? "" : info.alive ? " · loaded" : " · gone"}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close unit details" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white/80 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-micro tabular-nums">
        <div><dt className="text-white/60">Born</dt><dd>{formatClock(info.born)}</dd></div>
        <div><dt className="text-white/60">Died</dt><dd>{died === null ? "Survived" : formatClock(died)}</dd></div>
        <div><dt className="text-white/60">Lifetime</dt><dd>{formatClock(info.lifetime)}</dd></div>
        <div>
          <dt className="text-white/60">Attacks</dt>
          <dd title={info.attacks === null ? "This recording has no attack data. Regenerate accurate playback to record attacks." : undefined}>
            {info.attacks === null ? "Not recorded" : info.attacks.toLocaleString()}
          </dd>
        </div>
      </dl>
      <div className="mt-2 flex gap-1.5">
        <button type="button" className={BUTTON_CLASS} onClick={() => onJump(info.born)} aria-label={`Jump to birth at ${formatClock(info.born)}`}>
          <SkipBack className="h-3.5 w-3.5" aria-hidden />Birth
        </button>
        <button type="button" className={BUTTON_CLASS} disabled={died === null}
          onClick={() => { if (died !== null) onJump(Math.max(info.born, died - 1)); }}
          aria-label={died === null ? "No death to jump to" : `Jump to death at ${formatClock(died)}`}>
          <SkipForward className="h-3.5 w-3.5" aria-hidden />Death
        </button>
        <button type="button" className={BUTTON_CLASS} aria-pressed={following} disabled={!info.visible && !following}
          onClick={() => onFollow(!following)} title={following ? "Stop following (Esc)" : "Keep the camera on this unit"}>
          <Crosshair className="h-3.5 w-3.5" aria-hidden />{following ? "Following" : "Follow"}
        </button>
      </div>
    </section>
  );
}

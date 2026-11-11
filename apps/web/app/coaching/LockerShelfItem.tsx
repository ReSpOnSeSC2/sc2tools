"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { fmtDate } from "@/lib/format";
import type { LockerState } from "./lockerRosterModel";
import { downloadShelfFile, mediaSource, shelfAsset, shelfLink, shelfTitle, SHELF_KINDS, type ShelfItem, type ShelfKind } from "./lockerShelfModel";

function GameLabel({ game }: { game: unknown }) {
  if (!game || typeof game !== "object") return null;
  const { m, o, d, b } = game as Record<string, unknown>;
  const summary = [m, typeof o === "string" && o ? `vs ${o}` : null, d, b].filter(value => typeof value === "string" && value).join(" · ");
  return summary ? <p className="break-words text-caption text-text-muted">{summary}</p> : null;
}

function Attachment({ kind, item, state }: { kind: ShelfKind; item: ShelfItem; state: LockerState }) {
  const { toast } = useToast();
  const asset = shelfAsset(state, item);
  const src = mediaSource(kind, asset);
  const link = shelfLink(item.link);
  if (src && kind === "voice") return <audio className="max-w-full" controls preload="none" src={src} />;
  if (src && kind === "video") return <video className="max-h-80 max-w-full" aria-label={shelfTitle(item)} controls preload="none" src={src} />;
  // These local, verified raster data URLs are rendered directly.
  // eslint-disable-next-line @next/next/no-img-element
  if (src && kind === "image") return <img className="max-h-80 max-w-full rounded-md object-contain" alt={shelfTitle(item)} src={src} />;
  if (asset) return <Button size="sm" variant="secondary" onClick={() => {
    try { downloadShelfFile(asset); } catch { toast.error("The attachment could not be downloaded"); }
  }}>Download attachment</Button>;
  if (link) return <a className="inline-flex min-h-11 items-center font-semibold text-link hover:underline" href={link} target="_blank" rel="noopener noreferrer">
    {kind === "replay" ? "Open game or replay link" : "Open attachment link"}
  </a>;
  return item.asset || item.link ? <p className="text-caption text-text-muted">Attachment unavailable</p> : null;
}

export function LockerShelfItem({ item, state, children }: { item: ShelfItem; state: LockerState; children?: React.ReactNode }) {
  const kind = item.ty && Object.hasOwn(SHELF_KINDS, item.ty) ? item.ty as ShelfKind : undefined;
  const date = typeof item.d === "string" ? new Date(item.d) : null;
  return <li className="space-y-2 rounded-xl border border-border p-3">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="min-w-0 break-words font-semibold text-text">{shelfTitle(item)}</h3>
      {kind ? <Badge variant="neutral">{SHELF_KINDS[kind]}</Badge> : null}
      {date && Number.isFinite(date.getTime()) ? <time className="text-caption text-text-muted" dateTime={date.toISOString()}>{fmtDate(date)}</time> : null}
    </div>
    {typeof item.n === "string" && item.n ? <p className="whitespace-pre-wrap break-words text-body text-text">{item.n}</p> : null}
    {kind === "replay" ? <GameLabel game={item.game} /> : null}
    {kind ? <Attachment kind={kind} item={item} state={state} /> : null}
    {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
  </li>;
}

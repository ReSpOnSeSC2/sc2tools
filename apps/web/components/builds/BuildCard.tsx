"use client";

import { useState, type MouseEvent, type SyntheticEvent } from "react";
import {
  Eye,
  Loader2,
  MoreVertical,
  Pencil,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { fmtAgo, pct1, wrColor } from "@/lib/format";
import {
  matchupLabel,
  raceIconName,
  raceTint,
  type Race,
  type VsRace,
} from "@/lib/race";
import type { DecoratedBuild } from "./types";

export interface BuildCardProps {
  build: DecoratedBuild;
  onOpen: (slug: string) => void;
  onEdit: (slug: string) => void;
  onDelete: (slug: string) => void;
  onPublish: (slug: string) => void;
  onReclassify?: (slug: string) => void;
  reclassifying?: boolean;
}

/**
 * BuildCard — race-tinted card representing one custom build in the
 * library grid. Clicking the body opens the dossier modal in place;
 * the kebab menu surfaces edit / publish / delete. The whole card has
 * a left rail in the build's race tint.
 */
export function BuildCard({
  build,
  onOpen,
  onEdit,
  onDelete,
  onPublish,
  onReclassify,
  reclassifying = false,
}: BuildCardProps) {
  const tint = raceTint(build.race);
  const matchup = matchupLabel(build.race, (build.vsRace as VsRace) ?? "Any");
  const stats = build.stats;
  const fromOpponent = build.perspective === "opponent";

  return (
    <Card
      variant="interactive"
      padded={false}
      className={[
        "group relative h-full overflow-hidden",
        "focus-within:border-border-strong",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={["absolute left-0 top-0 h-full w-1", tint.rail].join(" ")}
      />
      <button
        type="button"
        onClick={() => onOpen(build.slug)}
        aria-label={`Open ${build.name || "build"} dossier`}
        className={[
          "absolute inset-0 z-0",
          "focus-visible:outline-none focus-visible:bg-bg-elevated",
        ].join(" ")}
      />
      <div className="relative pointer-events-none p-5 pl-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="neutral"
                size="sm"
                className={[tint.bg, tint.border, tint.text].join(" ")}
                iconLeft={
                  <Icon
                    name={raceIconName(build.race)}
                    kind="race"
                    size={14}
                    decorative
                  />
                }
              >
                {matchup}
              </Badge>
              {fromOpponent ? (
                <Badge
                  variant="cyan"
                  size="sm"
                  iconLeft={<Eye className="h-3 w-3" aria-hidden />}
                >
                  From opponent
                </Badge>
              ) : null}
              {build.isPublic ? (
                <Badge variant="accent" size="sm">
                  Published
                </Badge>
              ) : null}
              {reclassifying ? (
                <Badge
                  variant="neutral"
                  size="sm"
                  iconLeft={
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  }
                >
                  Reclassifying…
                </Badge>
              ) : null}
            </div>
            <h3 className="break-words text-h4 font-semibold leading-tight text-text">
              {build.name || "Untitled build"}
            </h3>
            {build.description ? (
              <p className="line-clamp-2 text-caption text-text-muted">
                {build.description}
              </p>
            ) : null}
          </div>
          <div className="pointer-events-auto">
            <BuildKebab
              slug={build.slug}
              isPublic={!!build.isPublic}
              onEdit={onEdit}
              onDelete={onDelete}
              onPublish={onPublish}
              onReclassify={onReclassify}
              reclassifying={reclassifying}
            />
          </div>
        </div>
        <BuildStatsRow build={build} stats={stats} />
      </div>
    </Card>
  );
}

function BuildStatsRow({
  build,
  stats,
}: {
  build: DecoratedBuild;
  stats: DecoratedBuild["stats"];
}) {
  const total = stats?.total ?? 0;
  const updated = build.updatedAt;
  return (
    <dl className="mt-4 flex flex-wrap items-end justify-between gap-3 text-caption">
      <div className="flex items-baseline gap-3">
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-text-dim">
            Win rate
          </dt>
          <dd
            className="text-body font-semibold tabular-nums"
            style={{
              color: total
                ? wrColor(stats?.winRate ?? 0, total)
                : "rgb(var(--text-dim))",
            }}
          >
            {total > 0 ? pct1(stats?.winRate ?? 0) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-text-dim">
            Record
          </dt>
          <dd className="text-body tabular-nums text-text">
            {total > 0 ? (
              <>
                <span className="text-success">{stats?.wins ?? 0}W</span>
                <span className="px-0.5 text-text-dim">·</span>
                <span className="text-danger">{stats?.losses ?? 0}L</span>
              </>
            ) : (
              <span className="text-text-dim">No games yet</span>
            )}
          </dd>
        </div>
      </div>
      <div className="text-right">
        {total > 0 ? (
          <Badge variant="neutral" size="sm">
            n = {total}
          </Badge>
        ) : null}
        {updated ? (
          <div className="mt-1 text-[11px] text-text-dim">
            Updated {fmtAgo(updated)}
          </div>
        ) : null}
      </div>
    </dl>
  );
}

interface BuildKebabProps {
  slug: string;
  isPublic: boolean;
  onEdit: (slug: string) => void;
  onDelete: (slug: string) => void;
  onPublish: (slug: string) => void;
  onReclassify?: (slug: string) => void;
  reclassifying?: boolean;
}

function BuildKebab({
  slug,
  isPublic,
  onEdit,
  onDelete,
  onPublish,
  onReclassify,
  reclassifying = false,
}: BuildKebabProps) {
  const [open, setOpen] = useState(false);

  function stop<E extends SyntheticEvent>(e: E) {
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div
      className="relative"
      onClick={(e: MouseEvent<HTMLDivElement>) => stop(e)}
    >
      <button
        type="button"
        aria-label="Build options"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(e) => {
          stop(e);
          setOpen((v) => !v);
        }}
        className={[
          "inline-flex h-11 w-11 items-center justify-center rounded-md",
          "text-text-muted hover:bg-bg-elevated hover:text-text",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        ].join(" ")}
      >
        <MoreVertical className="h-5 w-5" aria-hidden />
      </button>
      {open ? (
        <>
          <button
            aria-hidden
            tabIndex={-1}
            onClick={(e) => {
              stop(e);
              setOpen(false);
            }}
            className="fixed inset-0 z-30 cursor-default bg-transparent"
          />
          <ul
            role="menu"
            className={[
              "absolute right-0 top-12 z-40 w-52 overflow-hidden rounded-md border border-border bg-bg-surface shadow-[var(--shadow-card)]",
            ].join(" ")}
          >
            <KebabItem
              icon={<Pencil className="h-4 w-4" aria-hidden />}
              label="Edit"
              onClick={() => {
                setOpen(false);
                onEdit(slug);
              }}
            />
            {onReclassify ? (
              <KebabItem
                icon={
                  reclassifying ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <RefreshCw className="h-4 w-4" aria-hidden />
                  )
                }
                label={reclassifying ? "Reclassifying…" : "Reclassify replays"}
                disabled={reclassifying}
                onClick={() => {
                  setOpen(false);
                  onReclassify(slug);
                }}
              />
            ) : null}
            <KebabItem
              icon={<Send className="h-4 w-4" aria-hidden />}
              label={isPublic ? "Publish update" : "Publish"}
              onClick={() => {
                setOpen(false);
                onPublish(slug);
              }}
            />
            <KebabItem
              icon={<Trash2 className="h-4 w-4 text-danger" aria-hidden />}
              label="Delete"
              tone="danger"
              onClick={() => {
                setOpen(false);
                onDelete(slug);
              }}
            />
          </ul>
        </>
      ) : null}
    </div>
  );
}

function KebabItem({
  icon,
  label,
  onClick,
  tone,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "danger";
  disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        role="menuitem"
        onClick={onClick}
        disabled={disabled}
        className={[
          "flex w-full items-center gap-2 px-3 py-2 text-left text-caption",
          "focus-visible:outline-none focus-visible:bg-bg-elevated",
          "disabled:cursor-not-allowed disabled:opacity-60",
          tone === "danger"
            ? "text-danger hover:bg-danger/10"
            : "text-text hover:bg-bg-elevated",
        ].join(" ")}
      >
        {icon}
        {label}
      </button>
    </li>
  );
}

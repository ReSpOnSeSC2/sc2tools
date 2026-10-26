import Link from "next/link";
import { User } from "lucide-react";
import type { CommunityBuildListItem } from "./types";

export interface AuthorChipProps {
  /** Matches the projection returned by the community API. */
  build: Pick<CommunityBuildListItem, "authorName" | "ownerUserId" | "authorProfileHandle">;
  size?: "sm" | "md";
  className?: string;
}

const SIZE_CLASSES = {
  sm: "h-6 px-2 text-micro gap-1.5",
  md: "h-7 px-2.5 text-caption gap-2",
} as const;

/**
 * AuthorChip — renders the author handle.
 *
 * A declared author name remains visible on its published build. Only a fresh
 * authorProfileHandle capability creates a profile link; an owner UUID is
 * never enough. Without a declared name the pill stays Anonymous.
 */
export function AuthorChip({
  build,
  size = "md",
  className = "",
}: AuthorChipProps) {
  const sizeCls = SIZE_CLASSES[size];
  const baseCls = [
    "inline-flex min-w-0 max-w-full items-center rounded-full border border-border bg-bg-elevated font-medium",
    sizeCls,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const name = typeof build.authorName === "string" ? build.authorName.trim() : "";
  if (!name) {
    return (
      <span
        className={[baseCls, "text-text-dim"].join(" ")}
        title="Anonymous author"
      >
        <User className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">Anonymous</span>
      </span>
    );
  }

  if (!build.authorProfileHandle || !/^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{10}$/.test(build.authorProfileHandle)) {
    return <span className={[baseCls, "text-text-muted"].join(" ")}><User className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate">{name}</span></span>;
  }

  return (
    <Link
      href={`/players/${encodeURIComponent(build.authorProfileHandle)}`}
      className={[
        baseCls,
        "min-h-11 text-text transition-colors hover:border-accent-cyan/60 hover:bg-accent-cyan/10 hover:text-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
      ].join(" ")}
      title={build.authorName}
      aria-label={build.authorName}
    >
      <User className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{build.authorName}</span>
    </Link>
  );
}

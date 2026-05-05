import Link from "next/link";
import { User } from "lucide-react";
import { hasPublicAuthor, type CommunityBuildListItem } from "./types";

export interface AuthorChipProps {
  /** Matches the projection returned by the community API. */
  build: Pick<CommunityBuildListItem, "authorName" | "ownerUserId">;
  size?: "sm" | "md";
  className?: string;
}

const SIZE_CLASSES = {
  sm: "h-6 px-2 text-[11px] gap-1.5",
  md: "h-7 px-2.5 text-caption gap-2",
} as const;

/**
 * AuthorChip — renders the author handle.
 *
 * When the build carries a non-empty `authorName` AND `ownerUserId`,
 * the chip becomes a Link to /community/authors/{ownerUserId}. When
 * either is missing, we render a static "Anonymous" pill. The chip is
 * the same shape in both states so the surrounding layout doesn't
 * jump when one row is anonymous and the next isn't.
 */
export function AuthorChip({
  build,
  size = "md",
  className = "",
}: AuthorChipProps) {
  const sizeCls = SIZE_CLASSES[size];
  const baseCls = [
    "inline-flex items-center rounded-full border border-border bg-bg-elevated font-medium",
    sizeCls,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (!hasPublicAuthor(build)) {
    return (
      <span
        className={[baseCls, "text-text-dim"].join(" ")}
        title="Anonymous author"
      >
        <User className="h-3 w-3" aria-hidden />
        Anonymous
      </span>
    );
  }

  return (
    <Link
      href={`/community/authors/${encodeURIComponent(build.ownerUserId)}`}
      className={[
        baseCls,
        "text-text transition-colors hover:border-accent-cyan/60 hover:bg-accent-cyan/10 hover:text-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
      ].join(" ")}
      title={`View ${build.authorName}'s profile`}
    >
      <User className="h-3 w-3" aria-hidden />
      {build.authorName}
    </Link>
  );
}

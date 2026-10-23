"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { EmptyStatePanel } from "./EmptyState";

/**
 * Card primitive — surface container with variants.
 *
 * Two usage shapes are supported:
 *   1. Legacy props ({ title, right }) — used by analyzer pages.
 *   2. Composed (Card.Header / Card.Body / Card.Footer) — preferred
 *      for new code so the structure is explicit.
 */

export type CardVariant = "default" | "elevated" | "feature" | "interactive";

// Courtside cards: a bold 2px ink outline + a hard offset shadow (no blur) so
// every surface reads like a physical "playbook sticker" rather than a soft
// generic panel. The feature variant swaps the ink line for an accent outline.
const VARIANT_CLASSES: Record<CardVariant, string> = {
  default: "bg-bg-surface border-2 border-line shadow-hard",
  elevated: "bg-bg-surface border-2 border-line shadow-hard",
  feature: "bg-bg-surface border-2 border-accent shadow-hard",
  interactive:
    "bg-bg-surface border-2 border-line shadow-hard hover:border-accent hover:bg-bg-elevated transition-colors cursor-pointer",
};

/** Heading level for the legacy inline `title`. */
export type CardHeadingLevel = 2 | 3 | 4;

interface CardBaseProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  variant?: CardVariant;
  /** Legacy: render header inline. Prefer composing <Card.Header>. */
  title?: ReactNode;
  /**
   * Level of the `title` heading (default 3). Use 2 for a card that sits
   * directly under the page's <h1>, so headings never skip a level.
   * The look stays the same at every level.
   */
  headingLevel?: CardHeadingLevel;
  /** Legacy: right slot in inline header. */
  right?: ReactNode;
  /** Legacy: when both title/right omitted, body still gets default padding. */
  padded?: boolean;
}

export function Card({
  variant = "default",
  title,
  headingLevel = 3,
  right,
  padded = true,
  className = "",
  children,
  ...rest
}: CardBaseProps) {
  const hasInlineHeader = title !== undefined || right !== undefined;
  const Heading = `h${headingLevel}` as const;
  return (
    <section
      className={[
        "overflow-hidden rounded-xl",
        VARIANT_CLASSES[variant],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {hasInlineHeader ? (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          {title ? (
            <Heading className="text-caption font-semibold text-text">{title}</Heading>
          ) : (
            <span />
          )}
          {right ? <div className="flex items-center gap-2">{right}</div> : null}
        </header>
      ) : null}
      {hasInlineHeader || padded ? (
        <div className={hasInlineHeader ? "p-4" : padded ? "p-4" : ""}>
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

Card.Header = function CardHeader({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLElement>) {
  return (
    <header
      className={[
        "flex items-center justify-between gap-3 border-b border-border px-4 py-3",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </header>
  );
};

Card.Body = function CardBody({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={["p-4", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
};

Card.Footer = function CardFooter({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLElement>) {
  return (
    <footer
      className={[
        "flex items-center justify-end gap-2 border-t border-border px-4 py-3",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </footer>
  );
};

/* ============================================================
 * Legacy helper exports — kept so existing analyzer pages keep
 * compiling. New code should import EmptyState/Stat/Skeleton from
 * their dedicated primitive modules.
 * ============================================================ */

export function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard">
      <div className="text-micro uppercase tracking-wider text-text-dim">
        {label}
      </div>
      <div
        className="mt-1 text-xl font-display font-bold tabular-nums"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * The analyzer's inline "nothing here" message, drawn by EmptyStatePanel
 * so every empty state shares one look. `helpSlug` adds a "Learn how"
 * link to that help article; `action` adds a button next to it.
 */
export function EmptyState({
  title = "Nothing here yet",
  sub,
  helpSlug,
  action,
  icon,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  helpSlug?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  const help = helpSlug ? <LazyHelpLink slug={helpSlug}>Learn how</LazyHelpLink> : null;
  return (
    <EmptyStatePanel
      title={title}
      description={sub}
      icon={icon}
      action={
        action || help ? (
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-caption">
            {action}
            {help}
          </div>
        ) : undefined
      }
    />
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="rounded-xl border-2 border-line bg-bg-surface shadow-hard divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex animate-pulse gap-4 p-4">
          <div className="h-4 w-32 rounded bg-bg-elevated" />
          <div className="h-4 w-12 rounded bg-bg-elevated" />
          <div className="h-4 w-12 rounded bg-bg-elevated" />
          <div className="h-4 w-24 rounded bg-bg-elevated" />
        </div>
      ))}
    </div>
  );
}

export function WrBar({
  wins,
  losses,
}: {
  wins: number;
  losses: number;
}) {
  const total = wins + losses;
  const wp = total > 0 ? (wins / total) * 100 : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-bg-elevated">
      <div
        className="h-full bg-success"
        style={{ width: `${wp}%` }}
      />
    </div>
  );
}

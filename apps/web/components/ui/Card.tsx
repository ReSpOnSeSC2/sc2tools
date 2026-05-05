"use client";

import type { HTMLAttributes, ReactNode } from "react";

/**
 * Card primitive — surface container with variants.
 *
 * Two usage shapes are supported:
 *   1. Legacy props ({ title, right }) — used by analyzer pages.
 *   2. Composed (Card.Header / Card.Body / Card.Footer) — preferred
 *      for new code so the structure is explicit.
 */

export type CardVariant = "default" | "elevated" | "feature" | "interactive";

const VARIANT_CLASSES: Record<CardVariant, string> = {
  default: "bg-bg-surface border border-border",
  elevated:
    "bg-bg-surface border border-border shadow-[var(--shadow-card)]",
  feature:
    "bg-bg-surface border border-accent/30 shadow-halo-cyan",
  interactive:
    "bg-bg-surface border border-border hover:border-border-strong hover:bg-bg-elevated transition-colors cursor-pointer",
};

interface CardBaseProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  variant?: CardVariant;
  /** Legacy: render header inline. Prefer composing <Card.Header>. */
  title?: ReactNode;
  /** Legacy: right slot in inline header. */
  right?: ReactNode;
  /** Legacy: when both title/right omitted, body still gets default padding. */
  padded?: boolean;
}

export function Card({
  variant = "default",
  title,
  right,
  padded = true,
  className = "",
  children,
  ...rest
}: CardBaseProps) {
  const hasInlineHeader = title !== undefined || right !== undefined;
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
            <h3 className="text-caption font-semibold text-text">{title}</h3>
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
    <div className="rounded-lg border border-border bg-bg-elevated p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-dim">
        {label}
      </div>
      <div
        className="mt-1 text-xl font-semibold tabular-nums"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

export function EmptyState({
  title = "No data",
  sub,
}: {
  title?: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
      <div className="text-sm font-medium text-text-muted">{title}</div>
      {sub ? <div className="text-xs text-text-dim">{sub}</div> : null}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card divide-y divide-border">
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

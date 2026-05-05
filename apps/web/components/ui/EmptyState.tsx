import type { ReactNode } from "react";

/**
 * EmptyState — placeholder for sections with no data yet.
 *
 * Note: a simpler EmptyState is also exported from Card.tsx for
 * legacy callers. New code should use this richer variant which
 * supports an icon, action slot, and configurable padding.
 */
export interface EmptyStateProps {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const PAD_CLASSES = {
  sm: "py-6",
  md: "py-10",
  lg: "py-16",
} as const;

export function EmptyStatePanel({
  title = "Nothing here yet",
  description,
  icon,
  action,
  size = "md",
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={[
        "flex flex-col items-center justify-center gap-3 text-center",
        PAD_CLASSES[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {icon ? (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-elevated text-text-muted">
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <div className="text-body font-medium text-text">{title}</div>
        {description ? (
          <p className="text-caption text-text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

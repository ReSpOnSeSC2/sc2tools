import type { ReactNode } from "react";

export type DeviceFrameVariant = "browser" | "app" | "phone";

export interface DeviceFrameProps {
  variant?: DeviceFrameVariant;
  /** Title shown in the chrome bar (browser url, app title). */
  title?: ReactNode;
  /** Body content — landing pages typically pass a placeholder image or screenshot. */
  children: ReactNode;
  className?: string;
  /** When true, adds a soft cyan halo behind the frame. */
  glow?: boolean;
}

/**
 * DeviceFrame — fake browser / app / phone chrome around a body slot.
 * Used by the landing page to mockup screenshots without shipping
 * full screenshot images yet. Server-component-safe.
 */
export function DeviceFrame({
  variant = "browser",
  title,
  children,
  className = "",
  glow = false,
}: DeviceFrameProps) {
  const isPhone = variant === "phone";
  return (
    <div
      className={[
        "relative",
        isPhone ? "max-w-[280px]" : "w-full",
        glow ? "drop-shadow-[0_0_60px_var(--halo-cyan)]" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        className={[
          "overflow-hidden border border-border bg-bg-surface shadow-[var(--shadow-card)]",
          isPhone ? "rounded-[2rem]" : "rounded-xl",
        ].join(" ")}
      >
        <Chrome variant={variant} title={title} />
        <div
          className={[
            "bg-bg",
            isPhone ? "min-h-[420px]" : "min-h-[240px]",
          ].join(" ")}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function Chrome({
  variant,
  title,
}: {
  variant: DeviceFrameVariant;
  title?: ReactNode;
}) {
  if (variant === "phone") {
    return (
      <div className="flex h-7 items-center justify-center border-b border-border bg-bg-elevated">
        <span className="h-1 w-16 rounded-full bg-bg-subtle" aria-hidden />
      </div>
    );
  }
  return (
    <div className="flex h-9 items-center gap-2 border-b border-border bg-bg-elevated px-3">
      <span className="flex gap-1.5" aria-hidden>
        <span className="h-2.5 w-2.5 rounded-full bg-danger/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
      </span>
      {title ? (
        <div className="flex flex-1 justify-center">
          <span className="rounded-md border border-border bg-bg-surface px-3 py-0.5 text-[11px] text-text-muted">
            {title}
          </span>
        </div>
      ) : null}
      <span className="w-12" aria-hidden />
    </div>
  );
}

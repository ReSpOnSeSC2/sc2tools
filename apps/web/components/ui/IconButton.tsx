"use client";

import { forwardRef, type ReactNode } from "react";
import { Button, type ButtonProps } from "./Button";

export type IconButtonProps = Omit<ButtonProps, "children" | "iconLeft" | "iconRight" | "aria-label" | "size" | "fullWidth"> & {
  "aria-label": string;
  children: ReactNode;
  size?: "md" | "lg";
};

/** An icon-only action with an explicit accessible name and a 44px minimum. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ "aria-label": label, children, size = "md", variant = "ghost", className = "", title = label, ...props }, ref) {
    return <Button {...props} ref={ref} aria-label={label} title={title} size={size} variant={variant}
      className={`min-h-11 min-w-11 !p-0 ${size === "lg" ? "w-12" : "w-11"} ${className}`}>
      <span aria-hidden="true" className="inline-flex items-center justify-center">{children}</span>
    </Button>;
  },
);

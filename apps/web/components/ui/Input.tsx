"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

export type InputSize = "sm" | "md" | "lg";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  inputSize?: InputSize;
  invalid?: boolean;
}

const SIZE_CLASSES: Record<InputSize, string> = {
  sm: "h-8 px-2.5 text-caption rounded-md",
  md: "h-10 px-3 text-body rounded-lg",
  lg: "h-12 px-4 text-body-lg rounded-lg",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { inputSize = "md", invalid = false, className = "", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={[
        "block w-full bg-bg-subtle/40 text-text border placeholder:text-text-dim",
        "transition-[border-color,box-shadow,background-color] hover:bg-bg-subtle/60",
        invalid
          ? "border-danger focus:border-danger focus:ring-danger/20"
          : "border-border-strong focus:border-accent focus:ring-accent/20",
        "focus:outline-none focus:ring-4",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        SIZE_CLASSES[inputSize],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
});

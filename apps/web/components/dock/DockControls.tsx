"use client";

import { forwardRef } from "react";
import { Button, type ButtonProps } from "@/components/ui/Button";
import { Input, type InputProps } from "@/components/ui/Input";
import { Select, type SelectProps } from "@/components/ui/Select";
import { Toggle, type ToggleProps } from "@/components/ui/Toggle";

/** Dense mouse controls for OBS; coarse pointers retain a 40px target. */
export const DOCK_CONTROL = "min-h-8 [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10";
type DockButtonProps = Omit<ButtonProps, "size"> & { danger?: boolean; success?: boolean };
export const DockButton = forwardRef<HTMLButtonElement, DockButtonProps>(function DockButton({ danger, success, variant, className = "", style, ...props }, ref) {
  return <Button ref={ref} size="sm" variant={variant ?? (danger ? "danger" : "secondary")} className={`${DOCK_CONTROL} ${success ? "border-success/50 bg-success/15 text-success hover:bg-success/25" : ""} ${className}`} style={{ ...style, height: "2rem" }} {...props} />;
});
export const DockInput = forwardRef<HTMLInputElement, InputProps>(function DockInput({ className = "", ...props }, ref) {
  return <Input ref={ref} inputSize="sm" className={`${DOCK_CONTROL} ${className}`} {...props} />;
});
export const DockSelect = forwardRef<HTMLSelectElement, SelectProps>(function DockSelect({ className = "", ...props }, ref) {
  return <Select ref={ref} selectSize="sm" className={`${DOCK_CONTROL} ${className}`} {...props} />;
});
export const DockToggle = forwardRef<HTMLButtonElement, ToggleProps>(function DockToggle({ className = "", ...props }, ref) {
  return <Toggle ref={ref} className={`${DOCK_CONTROL} ${className}`} {...props} />;
});

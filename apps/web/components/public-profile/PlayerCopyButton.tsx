"use client";
import { CopyButton } from "@/components/ui/CopyButton";

/** Shared bounded clipboard control, keyed by the exact public URL. */
export function PlayerCopyButton({ path, label }: { path: string; label: string }) {
  const text = typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
  return <CopyButton text={text} scopeKey={path} className="min-h-11" size="sm" fallbackLabel={label}>{label}</CopyButton>;
}

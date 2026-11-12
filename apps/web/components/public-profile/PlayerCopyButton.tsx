"use client";
import { useCallback } from "react";
import { CopyButton } from "@/components/ui/CopyButton";

/** Shared bounded clipboard control, keyed by the exact public URL. */
export function PlayerCopyButton({ path, label }: { path: string; label: string }) {
  const text = useCallback(() => new URL(path, window.location.origin).toString(), [path]);
  return <CopyButton text={text} scopeKey={path} className="min-h-11" size="sm" fallbackLabel={label}>{label}</CopyButton>;
}

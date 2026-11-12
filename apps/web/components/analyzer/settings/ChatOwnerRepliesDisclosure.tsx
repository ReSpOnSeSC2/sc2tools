"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { ChatCommandPreferences } from "@/lib/multichat/chatCommandPreferences";
import { ChatOwnerRepliesPanel } from "./ChatOwnerRepliesPanel";

export function ChatOwnerRepliesDisclosure({ owner, token, commands }: { owner: string; token: string; commands: ChatCommandPreferences | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    const element = root.current;
    if (!open || !element) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      toggle.current?.focus();
    };
    element.addEventListener("keydown", closeOnEscape);
    return () => element.removeEventListener("keydown", closeOnEscape);
  }, [open]);
  if (!commands) return null;
  return <div ref={root} className="space-y-2">
    <Button ref={toggle} size="sm" variant="secondary" className="min-h-11" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>{open ? "Close live replies" : "Open live replies"}</Button>
    <div id={id} hidden={!open}>{open ? <ChatOwnerRepliesPanel owner={owner} token={token} commands={commands} /> : null}</div>
  </div>;
}

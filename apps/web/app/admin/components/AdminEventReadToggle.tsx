"use client";

import { useEffect, useRef, useState } from "react";
import { Mail, MailOpen } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { useToastOptional } from "@/components/ui/Toast";

/**
 * One notification's optimistic read state. ``toggle`` shows the new state
 * at once; a failed save rolls back and raises "Couldn't mark as read" with
 * Retry (toggling again retries too). The optimistic value lasts until the
 * row's own data agrees, so a parent refresh never flickers the old state.
 */
export function useOptimisticRead(unread: boolean, onSetRead: ((read: boolean) => Promise<unknown>) | undefined) {
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const toast = useToastOptional();
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (optimistic !== null && optimistic === unread && !pending) setOptimistic(null); }, [optimistic, unread, pending]);

  async function apply(nextUnread: boolean) {
    if (!onSetRead) return;
    setFailed(false);
    setPending(true);
    setOptimistic(nextUnread);
    try {
      await onSetRead(!nextUnread);
      if (live.current) setPending(false);
    } catch {
      if (!live.current) return;
      setPending(false);
      setOptimistic(null);
      setFailed(true);
      toast?.toast.error(nextUnread ? "Couldn't mark as unread" : "Couldn't mark as read", {
        description: <Button size="sm" variant="secondary" className="mt-2" onClick={() => { void apply(nextUnread); }}>Retry</Button>,
        duration: 10000,
      });
    }
  }

  const shownUnread = optimistic ?? unread;
  return { shownUnread, pending, failed, toggle: () => { if (!pending) void apply(!shownUnread); } };
}

/**
 * The row's Mark as read / Mark as unread icon button. Hidden until the row
 * is hovered or holds focus on pointer devices; always visible on touch
 * screens, while saving and after a failure.
 */
export function AdminEventReadToggle({ unread, title, pending, failed, onToggle }: {
  unread: boolean;
  /** The row's title, so each row's control has a unique accessible name. */
  title: string;
  pending: boolean;
  failed: boolean;
  onToggle: () => void;
}) {
  const visible = pending || failed
    ? "opacity-100"
    : "opacity-0 focus-visible:opacity-100 group-hover/event:opacity-100 group-focus-within/event:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100";
  return (
    <IconButton
      aria-label={`${unread ? "Mark as read" : "Mark as unread"}: ${title}`}
      title={unread ? "Mark as read" : "Mark as unread"}
      aria-busy={pending || undefined}
      data-read-state={unread ? "unread" : "read"}
      onClick={onToggle}
      className={`flex-none text-text-muted hover:text-text motion-safe:transition-opacity ${visible}`}
    >
      {unread ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
    </IconButton>
  );
}

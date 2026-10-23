"use client";

import { useEffect, useState } from "react";
import { age } from "@/lib/reviews";

export function CommentTime({ createdAt, editedAt }: { createdAt: string; editedAt: string | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const created = new Date(createdAt);
  const edited = editedAt ? new Date(editedAt) : null;
  if (!Number.isFinite(created.getTime())) return null;
  return <span className="text-micro text-text-dim"><time dateTime={createdAt} title={now !== null ? created.toLocaleString() : undefined}>{now !== null ? age(createdAt, now) : ""}</time>{edited && edited.getTime() - created.getTime() > 60_000 ? <span title={now !== null ? `Edited ${edited.toLocaleString()}` : undefined}> · edited</span> : null}</span>;
}

"use client";
import { use } from "react";
import { HumdingersWatch } from "../../../HumdingersWatch";

/** /admin/humdingers/watch/<userId>/<session>: one visit's run tape, replayed (ADR 0113). */
export default function HumdingersWatchPage({ params }: { params: Promise<{ userId: string; session: string }> }) {
  const { userId, session } = use(params);
  return <HumdingersWatch key={`${userId}/${session}`} userId={decodeURIComponent(userId)} session={decodeURIComponent(session)} />;
}

"use client";
import dynamic from "next/dynamic";
import { Component, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Sparkles } from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { NEWEST_WHATS_NEW_AT } from "@/lib/whatsNew";
import { Modal } from "@/components/ui/Modal";
const WhatsNewSheet = dynamic(() => import("./WhatsNewSheet"), { ssr: false });
type Me = { onboarding?: { goals?: string[]; whatsNewSeenAt?: string } };
export function WhatsNewButton() {
  const { userId } = useAuth(); return userId ? <WhatsNewButtonInner key={userId} /> : null;
}
function WhatsNewButtonInner() {
  const { getToken } = useAuth(); const me = useApi<Me>("/v1/me");
  const [open, setOpen] = useState(false); const [seenAt, setSeenAt] = useState<string | null>(null); const [error, setError] = useState<ClientApiError | null>(null); const saving = useRef(false);
  const hasNew = !!me.data && Date.parse(NEWEST_WHATS_NEW_AT) > Date.parse(seenAt || me.data.onboarding?.whatsNewSeenAt || "1970-01-01");
  async function markSeen() {
    if (saving.current) return; saving.current = true; setError(null);
    const at = new Date().toISOString();
    try {
      await apiCall(getToken, "/v1/me/preferences/onboarding", { method: "PUT", body: JSON.stringify({ whatsNewSeenAt: at }) });
      setSeenAt(at); void me.mutate();
    } catch (cause) { setError(cause as ClientApiError); }
    finally { saving.current = false; }
  }
  return <>
    <button type="button" aria-label={hasNew ? "What's new, unread updates" : "What's new"} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); void markSeen(); }} className="hard-press relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-line bg-bg-surface text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <Sparkles className="h-4 w-4" aria-hidden />{hasNew ? <span aria-hidden className="absolute right-0 top-0 h-2 w-2 rounded-full bg-accent-cyan" /> : null}
    </button>
    {open ? <WhatsNewLoadBoundary onClose={() => setOpen(false)}><WhatsNewSheet goals={me.data?.onboarding?.goals} error={error} retry={() => void markSeen()} onClose={() => setOpen(false)} /></WhatsNewLoadBoundary> : null}
  </>;
}

class WhatsNewLoadBoundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <Modal open onClose={this.props.onClose} title="Updates could not load" description="You can still read the public changelog."><Link href="/changelog" onClick={this.props.onClose} className="text-accent-cyan underline">Open changelog</Link></Modal> : this.props.children;
  }
}

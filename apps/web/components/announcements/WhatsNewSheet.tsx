"use client";
import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { RequestError } from "@/components/ui/RequestError";
import type { ClientApiError } from "@/lib/clientApi";
import { WHATS_NEW, matchesGoals } from "@/lib/whatsNew";
import { WhatsNewEntries } from "./WhatsNewEntries";

export default function WhatsNewSheet({ goals, error, retry, onClose }: { goals?: string[]; error: ClientApiError | null; retry: () => void; onClose: () => void }) {
  return <Modal open onClose={onClose} title="What's new" description="Recent improvements for the things you use." desktopLayout="side" size="lg" footer={<Link href="/changelog" onClick={onClose} className="rounded px-3 py-2 text-accent-cyan focus-visible:ring-2 focus-visible:ring-accent">All updates and RSS feed →</Link>}>
    <div className="space-y-4">{error ? <RequestError title="Could not save your place" error={error} onRetry={retry} /> : null}<WhatsNewEntries entries={WHATS_NEW.filter((entry) => matchesGoals(entry, goals))} /></div>
  </Modal>;
}

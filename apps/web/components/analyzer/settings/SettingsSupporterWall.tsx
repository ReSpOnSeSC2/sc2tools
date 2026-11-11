"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { SUPPORTER_MESSAGE_MAX, SUPPORTER_NAME_MAX, type OwnSupporterEntry } from "@/lib/supporterWall";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { RequestError } from "@/components/ui/RequestError";
import { Section } from "@/components/ui/Section";

const PATH = "/v1/me/supporter-wall";
type Answer = { entry: OwnSupporterEntry | null };
const STATUS: Record<OwnSupporterEntry["status"], { label: string; variant: BadgeVariant; detail: string }> = {
  pending: { label: "Waiting for review", variant: "warning", detail: "Your entry appears on the Donate page once it has been reviewed." },
  approved: { label: "On the wall", variant: "success", detail: "Your entry is shown on the Donate page." },
  rejected: { label: "Not approved", variant: "neutral", detail: "This entry wasn't approved. Change the name or message and submit it again, or remove it." },
};

/**
 * Settings → Profile → Supporter wall: an explicit, revocable opt-in to
 * be thanked publicly on /donate. Not part of the Profile Save bar: adding
 * yourself is a consent action with its own button, and removing deletes
 * the entry.
 */
export function SettingsSupporterWall({ defaultName = "" }: { defaultName?: string }) {
  const { userId } = useAuth();
  return userId ? <SupporterWallForm key={userId} defaultName={defaultName} /> : null;
}

function SupporterWallForm({ defaultName }: { defaultName: string }) {
  const { getToken } = useAuth();
  const consentId = useId();
  const { data, error, isLoading, mutate } = useApi<Answer>(PATH, { revalidateOnFocus: false });
  const entry = data?.entry ?? null;
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || data === undefined) return;
    hydrated.current = true;
    setName(data.entry?.displayName ?? defaultName.slice(0, SUPPORTER_NAME_MAX));
    setMessage(data.entry?.message ?? "");
  }, [data, defaultName]);

  const trimmed = name.trim();
  const canSubmit = consent && trimmed.length >= 2 && trimmed.length <= SUPPORTER_NAME_MAX && message.length <= SUPPORTER_MESSAGE_MAX && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy("save"); setFeedback(null);
    try {
      const saved = await apiCall<Answer>(getToken, PATH, { method: "PUT", body: JSON.stringify({ displayName: trimmed, message: message.trim(), consent: true }) });
      await mutate(saved, { revalidate: false });
      if (saved.entry) { setName(saved.entry.displayName); setMessage(saved.entry.message); }
      setConsent(false);
      setFeedback({ error: false, text: "Thank you! Your entry is waiting for review and appears on the Donate page once approved." });
    } catch (cause) {
      setFeedback({ error: true, text: (cause as ClientApiError | undefined)?.message || "Couldn't save your entry. Try again." });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove"); setFeedback(null);
    try {
      await apiCall(getToken, PATH, { method: "DELETE" });
      await mutate({ entry: null }, { revalidate: false });
      setConfirmRemove(false); setConsent(false);
      setFeedback({ error: false, text: "Removed. Your entry is deleted; the public page updates within about 10 minutes." });
    } catch (cause) {
      setFeedback({ error: true, text: (cause as ClientApiError | undefined)?.message || "Couldn't remove your entry. Try again." });
    } finally {
      setBusy(null);
    }
  }

  const status = entry ? STATUS[entry.status] : null;
  return (
    <Section
      id="supporter-wall"
      className="scroll-mt-28"
      title="Supporter wall"
      description="Opt in to be thanked by name on the Donate page. It's never automatic, amounts are never shown, and you can remove yourself at any time."
    >
      {isLoading && data === undefined ? <Skeleton rows={2} /> : error && data === undefined ? (
        <RequestError error={error} onRetry={() => void mutate()} />
      ) : (
        <Card>
          <form className="min-w-0 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            {status ? (
              <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
                <span role="status"><span className="sr-only">Supporter wall: </span><Badge variant={status.variant} size="sm">{status.label}</Badge></span>
                <span>{status.detail}</span>
              </div>
            ) : null}
            <fieldset disabled={busy !== null} className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
              <legend className="sr-only">Supporter wall entry</legend>
              <Field label="Display name" hint={`${trimmed.length}/${SUPPORTER_NAME_MAX} characters. Links are removed.`}>
                <Input value={name} maxLength={SUPPORTER_NAME_MAX} autoComplete="nickname" onChange={(event) => { setName(event.target.value); setFeedback(null); }} />
              </Field>
              <Field label="Message (optional)" hint={`${message.length}/${SUPPORTER_MESSAGE_MAX} characters. Shown under your name.`}>
                <Input value={message} maxLength={SUPPORTER_MESSAGE_MAX} onChange={(event) => { setMessage(event.target.value); setFeedback(null); }} />
              </Field>
            </fieldset>
            <label htmlFor={consentId} className="flex min-h-11 items-start gap-3 text-caption text-text">
              <input id={consentId} type="checkbox" className="mt-1" checked={consent} disabled={busy !== null} onChange={(event) => setConsent(event.target.checked)} />
              <span>Show this display name and message publicly on the <Link href="/donate" className="font-semibold text-accent-cyan underline-offset-4 hover:underline">Donate page</Link>. I can remove it at any time.</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="min-h-11" loading={busy === "save"} disabled={!canSubmit}>{entry ? "Update my entry" : "Add me to the wall"}</Button>
              {entry ? <Button variant="ghost" className="min-h-11" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>Remove me from the wall</Button> : null}
            </div>
            <p className="text-caption text-text-muted">Every new or changed entry is reviewed before it appears. Removing an entry deletes it.</p>
            {feedback ? <p role={feedback.error ? "alert" : "status"} className={`text-caption ${feedback.error ? "text-danger" : "text-success"}`}>{feedback.text}</p> : null}
          </form>
        </Card>
      )}
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => { if (!busy) setConfirmRemove(false); }}
        onConfirm={() => void remove()}
        title="Remove yourself from the supporter wall?"
        description="Your name and message are deleted and stop appearing on the Donate page."
        confirmLabel="Remove me"
        loading={busy === "remove"}
      />
    </Section>
  );
}

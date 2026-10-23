"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { CheckCircle2 } from "lucide-react";

import { HelpLink } from "@/components/help/HelpLink";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import {
  clearFailedRequests,
  recentFailedRequests,
  type FailedRequest,
} from "@/lib/feedback/failedRequests";
import {
  collectReportContext,
  pickReportContext,
  reportContextItems,
  webBuildSha,
  type ReportContextItemId,
  type ReportMeProbe,
  type ReportType,
} from "@/lib/feedback/reportContext";
import { ReportContextPanel } from "./ReportContextPanel";
import { ReportHelpSuggestions } from "./ReportHelpSuggestions";
import { ReportTypePicker } from "./ReportTypePicker";

// Mirror the server-side caps in apps/api (adminEvents.js +
// routes/messages.js) so the UI guides the user before a round-trip.
const SUBJECT_MAX = 140;
const MESSAGE_MAX = 4000;

type Status = "idle" | "sending" | "sent";

const TYPE_COPY: Record<
  ReportType,
  { title: string; send: string; detailsLabel: string; subjectPlaceholder: string; detailsPlaceholder: string }
> = {
  problem: {
    title: "Report a problem",
    send: "Send report",
    detailsLabel: "What happened?",
    subjectPlaceholder: "e.g. Opponents page won't load",
    detailsPlaceholder: "What did you do, what did you expect, and what happened instead? Steps to repeat it help a lot.",
  },
  idea: {
    title: "Suggest a feature",
    send: "Send idea",
    detailsLabel: "Tell us more",
    subjectPlaceholder: "e.g. Show my win rate on each map",
    detailsPlaceholder: "What would you like to do, and how would it help you?",
  },
  question: {
    title: "Ask a question",
    send: "Send question",
    detailsLabel: "Your question",
    subjectPlaceholder: "e.g. How do I add a second account?",
    detailsPlaceholder: "What are you trying to do, and what have you tried so far?",
  },
};

/** Where the report was opened from, read once when the form opens. */
interface Snapshot {
  pathname: string;
  userAgent: string;
  viewport: { width: number; height: number };
  failedRequests: FailedRequest[];
  now: number;
}

/** A prefilled field, cut to the field's limit. */
function prefilledText(value: string | undefined, max: number): string {
  return (value ?? "").slice(0, max);
}

function takeSnapshot(): Snapshot {
  if (typeof window === "undefined") {
    return { pathname: "", userAgent: "", viewport: { width: 0, height: 0 }, failedRequests: [], now: 0 };
  }
  return {
    pathname: window.location.pathname,
    userAgent: window.navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    failedRequests: recentFailedRequests(),
    now: Date.now(),
  };
}

/**
 * What the form starts with each time it opens. The user can change or
 * clear all of it before sending. Read once per opening, so a parent
 * re-render never resets what has been typed.
 *
 * Examples:
 *   - the ? menu's "Suggest a feature": `{ type: "idea" }`
 *   - an error page: `{ type: "problem", subject: "Error on /app (ref 123)" }`
 *   - a crashed section (SectionBoundary): `{ subject, message }` with the
 *     page, the error and its Sentry event id in the details.
 */
export interface ReportPrefill {
  /** The kind of report (default "problem"). */
  type?: ReportType;
  subject?: string;
  message?: string;
}

export interface ReportIssueModalProps {
  open: boolean;
  onClose: () => void;
  prefill?: ReportPrefill;
}

/**
 * ReportIssueModal — lets a signed-in user send a problem, an idea or a
 * question to the site admins. Posts to `/v1/messages`, which records it
 * as a `user_message` admin event in the admin inbox.
 *
 *   - As the subject is typed, matching help articles appear under
 *     "These might help" (opened in a side sheet, so the draft stays).
 *   - "Included with your report" lists the diagnostics that go with it
 *     (page, site version, browser, window size, desktop app state, the
 *     last failed requests), each with its own checkbox. They are read
 *     when the form opens, so they describe the moment of the problem.
 *   - After sending, a thank-you state offers "Send another" or "Close".
 */
export function ReportIssueModal({ open, onClose, prefill }: ReportIssueModalProps) {
  const { getToken } = useAuth();
  const formId = useId();
  const subjectId = useId();
  const messageId = useId();
  const counterId = useId();
  const subjectRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const thanksRef = useRef<HTMLParagraphElement>(null);

  // Read when the form opens, so a parent re-render never resets what
  // the user has typed.
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;

  const [type, setType] = useState<ReportType>(prefill?.type ?? "problem");
  const [subject, setSubject] = useState(() => prefilledText(prefill?.subject, SUBJECT_MAX));
  const [message, setMessage] = useState(() => prefilledText(prefill?.message, MESSAGE_MAX));
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<ReportContextItemId>>(() => new Set());
  const [snapshot, setSnapshot] = useState<Snapshot>(takeSnapshot);
  // SWR shares /v1/me with the app chrome, so this is normally cached.
  const { data: me } = useApi<ReportMeProbe>(open ? "/v1/me" : null);

  // Start clean (or from the prefill) each time the form opens.
  useEffect(() => {
    if (!open) return;
    const start = prefillRef.current;
    setType(start?.type ?? "problem");
    setSubject(prefilledText(start?.subject, SUBJECT_MAX));
    setMessage(prefilledText(start?.message, MESSAGE_MAX));
    setStatus("idle");
    setError(null);
    setExcluded(new Set());
    setSnapshot(takeSnapshot());
  }, [open]);

  // Modal focuses its first control (the close button) on a zero-delay
  // timer; this one is scheduled after it (a parent's effects run after
  // its children's), so typing can start at once: the subject, or the
  // details when the subject came prefilled.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      (prefillRef.current?.subject ? messageRef.current : subjectRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (status === "sent") thanksRef.current?.focus();
  }, [status]);

  const context = useMemo(
    () => collectReportContext({ ...snapshot, me, build: webBuildSha() }),
    [snapshot, me],
  );
  const items = useMemo(() => reportContextItems(context), [context]);

  const copy = TYPE_COPY[type];
  const sending = status === "sending";
  const trimmedSubject = subject.trim();
  const trimmedMessage = message.trim();
  const canSubmit =
    !sending &&
    trimmedSubject.length > 0 &&
    trimmedMessage.length > 0 &&
    subject.length <= SUBJECT_MAX &&
    message.length <= MESSAGE_MAX;

  function toggleItem(id: ReportContextItemId, included: boolean) {
    setExcluded((current) => {
      const next = new Set(current);
      if (included) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus("sending");
    setError(null);
    const picked = pickReportContext(context, excluded);
    try {
      await apiCall(getToken, "/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          type,
          subject: trimmedSubject,
          message: trimmedMessage,
          ...(picked ? { context: picked } : {}),
        }),
      });
      // Those failures are reported now; the next report starts fresh.
      clearFailedRequests();
      setStatus("sent");
    } catch (err) {
      const apiErr = err as ClientApiError;
      setStatus("idle");
      setError(apiErr?.message || "Something went wrong sending your message. Please try again.");
    }
  }

  function sendAnother() {
    setSubject("");
    setMessage("");
    setError(null);
    setExcluded(new Set());
    setSnapshot(takeSnapshot());
    setStatus("idle");
  }

  const footer =
    status === "sent" ? (
      <>
        <Button variant="secondary" onClick={sendAnother}>
          Send another
        </Button>
        <Button onClick={onClose}>Close</Button>
      </>
    ) : (
      <>
        <Button variant="secondary" onClick={onClose} disabled={sending}>
          Cancel
        </Button>
        <Button type="submit" form={formId} loading={sending} disabled={!canSubmit}>
          {sending ? "Sending…" : copy.send}
        </Button>
      </>
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.title}
      description="It goes straight to the SC2 Tools team, and we read every one."
      size="md"
      footer={footer}
      disableScrimClose={sending}
    >
      {status === "sent" ? (
        <div role="status" className="flex flex-col items-center gap-3 py-6 text-center">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-success/40 bg-success/10 text-success">
            <CheckCircle2 className="h-6 w-6" aria-hidden />
          </span>
          <div className="space-y-1">
            <p ref={thanksRef} tabIndex={-1} className="text-body font-semibold text-text focus:outline-none">
              Thanks, we got it.
            </p>
            <p className="text-caption text-text-muted">
              If we need more detail, we&apos;ll email the address on your account.
            </p>
            <p className="text-caption text-text-muted">
              <HelpLink slug="report-a-problem">What happens next</HelpLink>
            </p>
          </div>
        </div>
      ) : (
        <form id={formId} onSubmit={handleSubmit} className="space-y-4" noValidate>
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-danger"
            >
              {error}
            </p>
          ) : null}

          <ReportTypePicker value={type} onChange={setType} disabled={sending} />

          <div className="space-y-1.5">
            <label htmlFor={subjectId} className="block text-caption font-medium text-text">
              Subject
            </label>
            <Input
              ref={subjectRef}
              id={subjectId}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={copy.subjectPlaceholder}
              maxLength={SUBJECT_MAX}
              invalid={subject.length > SUBJECT_MAX}
              autoComplete="off"
              required
            />
          </div>

          <ReportHelpSuggestions subject={subject} />

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor={messageId} className="block text-caption font-medium text-text">
                {copy.detailsLabel}
              </label>
              <span
                id={counterId}
                className={[
                  "text-caption tabular-nums",
                  message.length > MESSAGE_MAX ? "text-danger" : "text-text-dim",
                ].join(" ")}
              >
                {message.length}/{MESSAGE_MAX}
              </span>
            </div>
            <textarea
              ref={messageRef}
              id={messageId}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={copy.detailsPlaceholder}
              rows={6}
              maxLength={MESSAGE_MAX}
              required
              aria-describedby={counterId}
              className={[
                "block w-full rounded-lg border bg-bg-elevated px-3 py-2 text-body text-text",
                "placeholder:text-text-dim transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-accent/40",
                message.length > MESSAGE_MAX
                  ? "border-danger focus:border-danger"
                  : "border-border focus:border-accent",
              ].join(" ")}
            />
          </div>

          <ReportContextPanel items={items} excluded={excluded} onToggle={toggleItem} />

          <p className="text-caption text-text-dim">
            Your account email is always included so we can reply.{" "}
            <HelpLink slug="report-a-problem">How reports work</HelpLink>
          </p>
        </form>
      )}
    </Modal>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { CheckCircle2 } from "lucide-react";

import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { apiCall, type ClientApiError } from "@/lib/clientApi";

// Mirror the server-side caps in apps/api (adminEvents.js +
// routes/messages.js) so the UI guides the user before a round-trip.
const SUBJECT_MAX = 140;
const MESSAGE_MAX = 4000;

type Status = "idle" | "sending" | "sent";

/**
 * ReportIssueModal — lets a signed-in user send a bug report / message
 * to the site admins. Posts to `/v1/messages`, which records the note
 * as a `user_message` admin event so it lands in the admin inbox.
 *
 * Feedback is self-contained (inline success panel + inline error) so
 * the modal works anywhere in the app without depending on a global
 * ToastProvider, which is only mounted on certain feature pages.
 */
export function ReportIssueModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { getToken } = useAuth();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  // Reset to a clean slate each time the modal opens.
  useEffect(() => {
    if (open) {
      setSubject("");
      setMessage("");
      setStatus("idle");
      setError(null);
    }
  }, [open]);

  const trimmedSubject = subject.trim();
  const trimmedMessage = message.trim();
  const canSubmit =
    status !== "sending" &&
    trimmedSubject.length > 0 &&
    trimmedMessage.length > 0 &&
    subject.length <= SUBJECT_MAX &&
    message.length <= MESSAGE_MAX;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus("sending");
    setError(null);
    try {
      await apiCall(getToken, "/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          subject: trimmedSubject,
          message: trimmedMessage,
        }),
      });
      setStatus("sent");
    } catch (err) {
      const apiErr = err as ClientApiError;
      setStatus("idle");
      setError(
        apiErr?.message ||
          "Something went wrong sending your message. Please try again.",
      );
    }
  }

  const footer =
    status === "sent" ? (
      <button type="button" className="inline-flex items-center gap-2 rounded-lg px-4 py-[0.55rem] font-semibold transition-colors bg-accent text-bg hover:bg-accent-hover" onClick={onClose}>
        Done
      </button>
    ) : (
      <>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg px-4 py-[0.55rem] font-semibold transition-colors border border-border bg-bg-elevated text-text hover:bg-bg-subtle"
          onClick={onClose}
          disabled={status === "sending"}
        >
          Cancel
        </button>
        <button
          type="submit"
          form="report-issue-form"
          className="inline-flex items-center gap-2 rounded-lg px-4 py-[0.55rem] font-semibold transition-colors bg-accent text-bg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canSubmit}
        >
          {status === "sending" ? "Sending…" : "Send report"}
        </button>
      </>
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Report a bug or issue"
      description="Found something broken or have feedback? Send it straight to the team."
      size="md"
      footer={footer}
      disableScrimClose={status === "sending"}
    >
      {status === "sent" ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-success/40 bg-success/10 text-success">
            <CheckCircle2 className="h-6 w-6" aria-hidden />
          </span>
          <div className="space-y-1">
            <p className="text-body font-semibold text-text">
              Thanks — your report was sent.
            </p>
            <p className="text-caption text-text-muted">
              The team will review it. We may reach out via your account
              email if we need more detail.
            </p>
          </div>
        </div>
      ) : (
        <form
          id="report-issue-form"
          onSubmit={handleSubmit}
          className="space-y-4"
        >
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-danger"
            >
              {error}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <label
              htmlFor="report-subject"
              className="block text-caption font-medium text-text"
            >
              Subject
            </label>
            <Input
              id="report-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Brief summary (e.g. “Macro chart won’t load”)"
              maxLength={SUBJECT_MAX}
              invalid={subject.length > SUBJECT_MAX}
              autoFocus
              required
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="report-message"
                className="block text-caption font-medium text-text"
              >
                Details
              </label>
              <span
                className={[
                  "text-caption tabular-nums",
                  message.length > MESSAGE_MAX
                    ? "text-danger"
                    : "text-text-dim",
                ].join(" ")}
              >
                {message.length}/{MESSAGE_MAX}
              </span>
            </div>
            <textarea
              id="report-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What happened? What did you expect? Steps to reproduce help a lot."
              rows={6}
              maxLength={MESSAGE_MAX}
              required
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

          <p className="text-caption text-text-dim">
            Your account email is attached automatically so we can follow up.
          </p>
        </form>
      )}
    </Modal>
  );
}

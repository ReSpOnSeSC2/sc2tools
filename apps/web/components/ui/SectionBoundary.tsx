"use client";

import { Component, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { AlertTriangle, Flag, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LazyReportIssueModal } from "@/components/feedback/LazyReportIssueModal";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { supportMailto } from "@/lib/feedback/errorReport";
import { captureException } from "@/lib/sentry";
import { isTokenAuthRoute } from "@/lib/tokenAuthRoutes";

/**
 * SectionBoundary — keeps one broken section from taking the page down.
 *
 *   <SectionBoundary label="the live game panel">
 *     <LiveGamePanel />
 *   </SectionBoundary>
 *
 * When a child throws while rendering, the section is replaced by a
 * short message: "Couldn't show the live game panel", with
 *   - Try again: re-renders the section (often enough after a bad
 *     payload was refreshed),
 *   - Report this problem: opens the report form with the page, the
 *     error and its Sentry event id filled in (signed-in users; others
 *     get an email link),
 *   - Details: the error message and the event id.
 * The crash is sent to Sentry when it is configured.
 *
 * This is for render crashes. A failed request is not a crash: show it
 * with QueryState / RequestError.
 */
type Props = {
  /** Names the section in the message, e.g. "the live game panel". */
  label?: string;
  title?: string;
  children: ReactNode;
};

type State = {
  error: Error | null;
  /** Sentry event id; undefined while it is being recorded, null when Sentry is off. */
  eventId?: string | null;
};

export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, eventId: undefined };
  }

  componentDidCatch(error: Error) {
    void captureException(error).then((eventId) => {
      // Ignore a late id for a crash the user already reset.
      if (this.state.error === error) this.setState({ eventId });
    });
  }

  private reset = () => {
    this.setState({ error: null, eventId: undefined });
  };

  render() {
    const { error, eventId } = this.state;
    if (!error) return this.props.children;
    return (
      <SectionCrash
        label={this.props.label}
        title={this.props.title}
        error={error}
        eventId={eventId}
        onReset={this.reset}
      />
    );
  }
}

function SectionCrash({
  label,
  title,
  error,
  eventId,
  onReset,
}: {
  label?: string;
  title?: string;
  error: Error;
  eventId?: string | null;
  onReset: () => void;
}) {
  const section = label || "this section";
  const message = error.message || String(error);
  return (
    <div
      role="alert"
      data-testid="section-boundary"
      className="rounded-xl border-2 border-danger/30 bg-danger/5 p-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-body font-semibold text-text">{title || <>Couldn&apos;t show {section}</>}</p>
          <p className="text-caption text-text-muted">
            The rest of the page still works. Try again, and if it keeps happening, report it so we can fix it.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={onReset}
              iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />}
            >
              Try again
            </Button>
            <OmitOnError>
              <ReportProblem section={section} message={message} eventId={eventId} />
            </OmitOnError>
            <LazyHelpLink slug="something-went-wrong" className="text-caption">
              What does this mean?
            </LazyHelpLink>
          </div>
          <details className="pt-2 text-caption text-text-muted">
            <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-md font-semibold text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              Details
            </summary>
            <dl className="mt-1 space-y-1 rounded-lg border border-border bg-bg-surface p-3">
              <div>
                <dt className="font-semibold text-text">Message</dt>
                <dd className="break-words font-mono text-micro">{message}</dd>
              </div>
              <div>
                <dt className="font-semibold text-text">Error ID</dt>
                <dd className="break-all font-mono text-micro">
                  {eventId === undefined ? "Recording…" : eventId ?? "Not recorded"}
                </dd>
              </div>
            </dl>
          </details>
        </div>
      </div>
    </div>
  );
}

/**
 * The crash message must never crash itself: if the report action
 * can't render (say, no account context on this page), leave it out.
 */
class OmitOnError extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The report action. Overlay and dock pages run without Clerk (their
 * token is the credential), so nothing is offered there.
 */
function ReportProblem(props: { section: string; message: string; eventId?: string | null }) {
  const pathname = usePathname();
  if (isTokenAuthRoute(pathname)) return null;
  return <ReportProblemForAccount {...props} page={pathname || "/"} />;
}

function ReportProblemForAccount({
  section,
  message,
  eventId,
  page,
}: {
  section: string;
  message: string;
  eventId?: string | null;
  page: string;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const [open, setOpen] = useState(false);
  const subject = `Error in ${section} on ${page}`;
  const details = [
    "What I was doing:",
    "",
    "",
    "---",
    `Page: ${page}`,
    `Error: ${message}`,
    `Error ID: ${eventId ?? "not recorded"}`,
  ].join("\n");

  // Sending a report needs an account; everyone else can email.
  if (!isLoaded || !isSignedIn) {
    return (
      <a
        href={supportMailto(subject, details)}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-md text-caption font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Flag className="h-4 w-4" aria-hidden />
        Report this problem
      </a>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        iconLeft={<Flag className="h-4 w-4" aria-hidden />}
      >
        Report this problem
      </Button>
      {/* Loaded on first open: the form carries the help search index,
          which must not ride along with every page that has a section. */}
      <LazyReportIssueModal
        open={open}
        onClose={() => setOpen(false)}
        prefill={{ type: "problem", subject, message: details }}
      />
    </>
  );
}

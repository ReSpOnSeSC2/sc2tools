import { HELP_SUPPORT_EMAIL } from "@/lib/help/support";
import { sanitisePagePath } from "./sanitise";

/**
 * Prefills for reporting a crash from an error screen: the report form's
 * subject, and a mailto for people who can't use the form (signed out,
 * or the page that broke was the whole site). Kept free of React and
 * Clerk so app/global-error.tsx, which replaces the root layout, can use
 * it too.
 */

/** The report form's subject limit (the API's MESSAGE_SUBJECT_MAX). */
export const REPORT_SUBJECT_MAX = 140;

/**
 * Subject for a crash report: "Error on <path> (ref <digest>)". A long
 * path is shortened so the reference always fits.
 *
 * Example: `errorReportSubject("/app/opponents?x=1", "123")` → "Error on /app/opponents (ref 123)".
 */
export function errorReportSubject(pathname: string, digest?: string): string {
  const path = sanitisePagePath(pathname) || "/";
  const ref = digest ? ` (ref ${digest.slice(0, 64)})` : "";
  const room = REPORT_SUBJECT_MAX - "Error on ".length - ref.length;
  const shownPath = path.length > room ? `${path.slice(0, Math.max(1, room - 1))}…` : path;
  return `Error on ${shownPath}${ref}`;
}

/**
 * A mailto: link to support with a subject and body filled in.
 *
 * Example: `supportMailto("Hi", "Body")` → "mailto:responsecoaching@gmail.com?subject=Hi&body=Body".
 */
export function supportMailto(subject: string, body: string): string {
  return `mailto:${HELP_SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * The mailto behind an error screen's "email us" link. It carries the
 * error reference (Next's digest), so we can find the crash in the logs.
 */
export function errorReportMailto({ pathname, digest }: { pathname?: string; digest?: string }): string {
  const subject = pathname ? errorReportSubject(pathname, digest) : `SC2 Tools error${digest ? ` (ref ${digest})` : ""}`;
  const body = [
    "What were you doing when this happened?",
    "",
    "",
    "---",
    digest ? `Error reference: ${digest}` : "Error reference: none shown",
    pathname ? `Page: ${sanitisePagePath(pathname) || "/"}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return supportMailto(subject, body);
}

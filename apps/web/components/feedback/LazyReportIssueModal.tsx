"use client";

import dynamic from "next/dynamic";
import type { ReportIssueModalProps } from "./ReportIssueModal";

// The form pulls in the help search index for "These might help", so it
// loads on first open instead of riding along with every page's chrome.
const ReportIssueModal = dynamic(
  () => import("./ReportIssueModal").then((mod) => mod.ReportIssueModal),
  { ssr: false },
);

/**
 * The report form, loaded the first time it opens. Renders nothing while
 * closed, so each opening starts from a clean form.
 */
export function LazyReportIssueModal(props: ReportIssueModalProps) {
  return props.open ? <ReportIssueModal {...props} /> : null;
}

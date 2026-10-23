"use client";

import dynamic from "next/dynamic";
import { Component, type ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { supportMailto } from "@/lib/feedback/errorReport";
import type { ReportIssueModalProps } from "./ReportIssueModal";

// The form pulls in the help search index for "These might help", so it
// loads on first open instead of riding along with every page's chrome.
const ReportIssueModal = dynamic(
  () => import("./ReportIssueModal").then((mod) => mod.ReportIssueModal),
  { ssr: false },
);

/** Keep a failed report chunk inside the report dialog, even on error pages. */
class ReportLoadBoundary extends Component<ReportIssueModalProps & { children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { open, onClose, prefill } = this.props;
    const subject = prefill?.subject || "SC2 Tools feedback";
    const message = prefill?.message || "What happened, or what would you like help with?\n\n";
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Report form unavailable"
        description="The report form could not load. You can email the SC2 Tools team instead."
      >
        <a href={supportMailto(subject, message)} className={buttonClassName({ variant: "secondary" })}>
          Email support
        </a>
      </Modal>
    );
  }
}

/**
 * The report form, loaded the first time it opens. Renders nothing while
 * closed, so each opening starts from a clean form.
 */
export function LazyReportIssueModal(props: ReportIssueModalProps) {
  return props.open ? (
    <ReportLoadBoundary {...props}>
      <ReportIssueModal {...props} />
    </ReportLoadBoundary>
  ) : null;
}

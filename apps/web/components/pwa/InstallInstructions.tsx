"use client";
import type { ReactNode } from "react";
import { Share, Plus, MoreVertical } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import type { InstallPlatform } from "@/lib/pwa/install";
interface IosInstructionsSheetProps { onClose: () => void; }
interface AndroidFallbackSheetProps { onClose: () => void; }
export function InstallInstructions({ platform, onClose }: { platform: InstallPlatform; onClose: () => void }) {
  return platform.startsWith("ios") ? <IosInstructionsSheet onClose={onClose} safariFirst={platform === "ios-other"} /> : <AndroidFallbackSheet onClose={onClose} />;
}
interface InstructionStep {
  body: ReactNode;
}

interface InstructionsSheetProps {
  title: string;
  titleId: string;
  steps: ReadonlyArray<InstructionStep>;
  footnote?: ReactNode;
  onClose: () => void;
}

function InstructionsSheet({ title, steps, footnote, onClose }: InstructionsSheetProps) {
  return <Modal open title={title} onClose={onClose} mobileLayout="sheet" size="sm">
    <ol className="space-y-3 text-body text-text">{steps.map((step, index) => <li key={index} className="flex items-start gap-3"><span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent-cyan/40 bg-accent-cyan/10 font-mono text-caption font-semibold text-accent-cyan">{index + 1}</span><span className="flex-1">{step.body}</span></li>)}</ol>
    {footnote ? <p className="mt-4 rounded-lg border border-border bg-bg-elevated p-3 text-caption text-text-muted">{footnote}</p> : null}
    <button type="button" onClick={onClose} className="mt-6 min-h-11 w-full rounded-lg bg-accent px-4 font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Got it</button>
  </Modal>;
}

function Keycap({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-1.5 py-0.5 text-caption font-medium">
      {children}
    </span>
  );
}

function IosInstructionsSheet({ onClose, safariFirst = false }: IosInstructionsSheetProps & { safariFirst?: boolean }) {
  const steps: ReadonlyArray<InstructionStep> = [
    ...(safariFirst ? [{ body: <span>Open this page in Safari first.</span> }] : []),
    {
      body: (
        <span className="flex flex-wrap items-center gap-1.5">
          Tap the{" "}
          <Keycap>
            <Share className="h-3.5 w-3.5" aria-hidden /> Share
          </Keycap>{" "}
          button in Safari.
        </span>
      ),
    },
    {
      body: (
        <span className="flex flex-wrap items-center gap-1.5">
          Choose{" "}
          <Keycap>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add to Home Screen
          </Keycap>
          .
        </span>
      ),
    },
    {
      body: <span>Confirm with Add — the SC2 Tools icon lands on your home screen.</span>,
    },
  ];
  return (
    <InstructionsSheet
      title="Install SC2 Tools on iPhone"
      titleId="ios-install-title"
      steps={steps}
      onClose={onClose}
    />
  );
}

function AndroidFallbackSheet({ onClose }: AndroidFallbackSheetProps) {
  const steps: ReadonlyArray<InstructionStep> = [
    {
      body: (
        <span className="flex flex-wrap items-center gap-1.5">
          Tap the{" "}
          <Keycap>
            <MoreVertical className="h-3.5 w-3.5" aria-hidden /> menu
          </Keycap>{" "}
          in the top-right of Chrome.
        </span>
      ),
    },
    {
      body: (
        <span className="flex flex-wrap items-center gap-1.5">
          Choose <Keycap>Install app</Keycap> (or <Keycap>Add to Home screen</Keycap> on
          older Chrome).
        </span>
      ),
    },
    {
      body: <span>Tap Install — SC2 Tools lands on your home screen and app drawer.</span>,
    },
  ];
  return (
    <InstructionsSheet
      title="Install SC2 Tools on Android"
      titleId="android-install-title"
      steps={steps}
      footnote={
        <>
          If you don&apos;t see &ldquo;Install app&rdquo; in the menu, your phone may already
          have SC2 Tools installed — check your home screen and app drawer.
        </>
      }
      onClose={onClose}
    />
  );
}

"use client";

import { Component, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";

type EditorProps = { gameId: string; onChanged?: () => void; defaultExpanded: boolean; showRequestState: boolean; headingLevel: 2 | 4 };

function makeEditor(attempt: number, onRetry: () => void) {
  return dynamic<EditorProps>(
    async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          import("@/components/build-checkin/BuildCheckInCard").then(module => module.BuildCheckInCard),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Build selection load attempt ${attempt + 1} timed out`)), 20_000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
    { ssr: false, loading: ({ error }) => error ? <div className="space-y-2">
      <p role="alert" className="text-caption text-text-muted">Build selection couldn&apos;t load.</p>
      <Button variant="secondary" className="min-h-11" onClick={onRetry}>Retry build selection</Button>
    </div> : <p role="status" className="text-caption text-text-muted">Loading build selection…</p> },
  );
}

class EditorBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="space-y-2">
      <p role="alert" className="text-caption text-text-muted">Build selection couldn&apos;t load.</p>
      <Button variant="secondary" className="min-h-11" onClick={this.props.onRetry}>Retry build selection</Button>
    </div> : this.props.children;
  }
}

/** Private game editing stays out of the shared, read-only macro body. The
 * check-in module and its API request are loaded only after explicit intent. */
export function MacroBuildSelector({ gameId, onChanged }: { gameId: string; onChanged?: () => void }) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  if (!isLoaded || !isSignedIn || !userId || !gameId) return null;
  return <OwnedBuildSelector key={JSON.stringify([userId, gameId])} gameId={gameId} onChanged={onChanged} />;
}

function OwnedBuildSelector({ gameId, onChanged }: { gameId: string; onChanged?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const titleId = useId();
  const editorId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const retry = useCallback(() => {
    // The focused Retry button is about to unmount. Keep focus on a stable
    // container now; a later module response mustn't take it from another control.
    editorRef.current?.focus();
    setAttempt(value => value + 1);
  }, []);
  const Editor = useMemo(() => makeEditor(attempt, retry), [attempt, retry]);
  useLayoutEffect(() => {
    if (editing) editorRef.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);

  return <section aria-labelledby={titleId} className="min-w-0 space-y-3 rounded-xl border border-border bg-bg-elevated/40 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-48">
        <h3 id={titleId} className="font-semibold text-text">Build selection</h3>
        <p className="mt-1 text-caption text-text-muted">Choose your planned build or correct the opponent&apos;s build for this game.</p>
      </div>
      <Button ref={buttonRef} variant="secondary" className="min-h-11" aria-expanded={editing} aria-controls={editing ? editorId : undefined} onClick={() => {
        if (editing) restoreFocus.current = true;
        setEditing(value => !value);
      }}>{editing ? "Close build selection" : "Change build"}</Button>
    </div>
    {editing ? <div ref={editorRef} id={editorId} role="group" aria-label="Build selection editor" tabIndex={-1} className="min-w-0 outline-none">
      <EditorBoundary key={attempt} onRetry={retry}>
        <Editor gameId={gameId} onChanged={onChanged} defaultExpanded showRequestState headingLevel={4} />
      </EditorBoundary>
    </div> : null}
  </section>;
}

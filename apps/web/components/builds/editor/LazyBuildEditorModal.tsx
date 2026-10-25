"use client";

import { Component, Suspense, lazy, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { BuildEditorModalProps } from "./BuildEditorModal";

type Loader = () => Promise<ComponentType<BuildEditorModalProps>>;
const loadEditor: Loader = () => import("./BuildEditorModal").then(module => module.BuildEditorModal);

class EditorBoundary extends Component<{ onClose: () => void; retry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <Modal open onClose={this.props.onClose} title="Build editor could not load"
      footer={<><Button className="min-h-11" variant="secondary" onClick={this.props.onClose}>Cancel</Button><Button className="min-h-11" onClick={this.props.retry}>Retry editor</Button></>}>
      <p role="alert">The editor did not finish loading. Retry to open it; your replay and the surrounding page are still available.</p>
    </Modal> : this.props.children;
  }
}

/** Kept separate for a real rejected-loader consumer regression. Each Retry
 * creates a fresh lazy identity and calls import() again. */
export function BuildEditorIsland({ editorProps, loader = loadEditor }: { editorProps: BuildEditorModalProps; loader?: Loader }) {
  const [attempt, retry] = useState(0);
  const Editor = useMemo(() => lazy(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const component = await Promise.race([loader(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Build editor load attempt ${attempt + 1} timed out`)), 20_000);
      })]);
      return { default: component };
    } finally { clearTimeout(timer); }
  }), [loader, attempt]);
  return <EditorBoundary key={attempt} onClose={editorProps.onClose} retry={() => retry(value => value + 1)}>
    <Suspense fallback={<Modal open title="Loading build editor…" onClose={editorProps.onClose} footer={<Button className="min-h-11" variant="secondary" onClick={editorProps.onClose}>Cancel</Button>}><p role="status">Loading build editor…</p></Modal>}>
      <Editor {...editorProps} />
    </Suspense>
  </EditorBoundary>;
}

/** No editor/catalog module is requested while this optional modal is closed. */
export function LazyBuildEditorModal(props: BuildEditorModalProps) {
  return props.open ? <BuildEditorIsland editorProps={props} /> : null;
}

"use client";

import { Component, Suspense, createElement, lazy, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { DockButton } from "./DockControls";

class IslandBoundary extends Component<{ label: string; retry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div role="alert" className="space-y-2 text-caption text-text-muted">
      <p>Couldn&apos;t load {this.props.label}. Your other Dock controls still work.</p>
      <DockButton onClick={this.props.retry}>Retry {this.props.label}</DockButton>
    </div> : this.props.children;
  }
}

/** A new lazy identity on Retry reruns import(), rather than rethrowing its cached rejection. */
export function DockLazyPanel<Props extends object>({ loader, label, componentProps }: {
  loader: () => Promise<ComponentType<Props>>; label: string; componentProps: Props;
}) {
  const [attempt, retry] = useState(0);
  const Loaded = useMemo(() => lazy(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const component = await Promise.race([loader(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Optional Dock panel load ${attempt + 1} timed out`)), 20_000);
      })]);
      return { default: component };
    } finally { clearTimeout(timer); }
  }), [loader, attempt]);
  return <IslandBoundary key={attempt} label={label} retry={() => retry(value => value + 1)}>
    <Suspense fallback={<p role="status" className="text-caption text-text-muted">Loading {label}…</p>}>
      {createElement(Loaded, componentProps)}
    </Suspense>
  </IslandBoundary>;
}

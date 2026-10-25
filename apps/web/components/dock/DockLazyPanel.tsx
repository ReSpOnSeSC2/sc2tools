"use client";

import { Component, createElement, useEffect, useState, type ComponentType, type ReactNode } from "react";
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

/** Imports stay outside render. Retry invokes the stable factory again, while
 * a held/failed optional chunk cannot keep an initially suspended Dock in an
 * endless retry cycle as other control snapshots commit. */
export function DockLazyPanel<Props extends object>({ loader, label, componentProps }: {
  loader: () => Promise<ComponentType<Props>>; label: string; componentProps: Props;
}) {
  const [attempt, retry] = useState(0);
  const [loaded, setLoaded] = useState<{ loader: typeof loader; attempt: number; component: ComponentType<Props> | null; failed: boolean } | null>(null);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => { if (current) { current = false; setLoaded({ loader, attempt, component: null, failed: true }); } }, 20_000);
    Promise.resolve().then(loader).then(component => {
      if (current) { clearTimeout(timer); setLoaded({ loader, attempt, component, failed: false }); }
    }).catch(() => { if (current) { clearTimeout(timer); setLoaded({ loader, attempt, component: null, failed: true }); } });
    return () => { current = false; clearTimeout(timer); };
  }, [loader, attempt]);
  const ready = loaded?.loader === loader && loaded.attempt === attempt ? loaded : null;
  return <IslandBoundary key={attempt} label={label} retry={() => retry(value => value + 1)}>
    {ready?.failed ? <div role="alert" className="space-y-2 text-caption text-text-muted"><p>Couldn&apos;t load {label}. Your other Dock controls still work.</p><DockButton onClick={() => retry(value => value + 1)}>Retry {label}</DockButton></div>
      : ready?.component ? createElement(ready.component, componentProps) : <p role="status" className="text-caption text-text-muted">Loading {label}…</p>}
  </IslandBoundary>;
}

"use client";

import { Component, createElement, lazy, Suspense, useMemo, useState, type ComponentType, type ReactNode } from "react";

class LoadBoundary extends Component<{ label: string; retry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <span role="alert" className="inline-flex flex-wrap items-center gap-2 text-caption text-text-muted">Couldn&apos;t load {this.props.label}.<button type="button" className="min-h-11 px-2 text-accent underline" onClick={this.props.retry}>Retry {this.props.label}</button></span> : this.props.children;
  }
}

/** Retry gets a new lazy identity and reruns the import factory. */
export function PracticeLazy<Props extends object>({ loader, componentProps, label, fallback = null }: {
  loader: () => Promise<ComponentType<Props>>; componentProps: Props; label: string; fallback?: ReactNode;
}) {
  const [attempt, retry] = useState(0);
  const Loaded = useMemo(() => lazy(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const component = await Promise.race([loader(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Practice load ${attempt + 1} timed out`)), 20_000); })]);
      return { default: component };
    } finally { clearTimeout(timer); }
  }), [loader, attempt]);
  return <LoadBoundary key={attempt} label={label} retry={() => retry(value => value + 1)}><Suspense fallback={fallback}>{createElement(Loaded, componentProps)}</Suspense></LoadBoundary>;
}

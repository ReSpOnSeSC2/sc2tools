"use client";

import { Component, type ReactNode } from "react";

type Props = { label?: string; children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (typeof window !== "undefined" && (window as any).Sentry?.captureException) {
      (window as any).Sentry.captureException(error);
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          Failed to render {this.props.label || "this section"}:{" "}
          <span className="font-mono">{this.state.error.message}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

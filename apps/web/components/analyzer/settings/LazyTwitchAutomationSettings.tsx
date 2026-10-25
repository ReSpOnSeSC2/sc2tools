"use client";
import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
class SettingsBoundary extends Component<{ retry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert" className="space-y-2 text-caption"><p>Twitch automation settings could not load. Your other settings remain available.</p><Button variant="secondary" className="min-h-11" onClick={this.props.retry}>Retry Twitch settings</Button></div> : this.props.children; }
}
const loadSettings = () => import("./SettingsTwitchAutomation").then(module => module.SettingsTwitchAutomation);
export function LazyTwitchAutomationSettings({ loader = loadSettings }: { loader?: typeof loadSettings }) {
  const [open, setOpen] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => { const reveal = () => { if (window.location.hash === "#twitch-automation") setOpen(true); }; reveal(); window.addEventListener("hashchange", reveal); return () => window.removeEventListener("hashchange", reveal); }, []);
  const Loaded = useMemo(() => lazy(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return { default: await Promise.race([loader(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Twitch settings load ${attempt + 1} timed out`)), 20_000); })]) }; }
    finally { clearTimeout(timer); }
  }), [loader, attempt]);
  return <details id="twitch-automation" open={open} onToggle={event => setOpen(event.currentTarget.open)} className="min-w-0 rounded-lg border border-border bg-bg-surface p-3">
    <summary className="min-h-11 cursor-pointer text-body font-semibold">Twitch automation <span className="ml-2 text-caption font-normal text-text-muted">Optional Predictions & markers</span></summary>
    {open ? <div className="mt-3"><SettingsBoundary key={attempt} retry={() => setAttempt(value => value + 1)}><Suspense fallback={<p role="status" className="text-caption">Loading Twitch automation settings…</p>}><Loaded /></Suspense></SettingsBoundary></div> : null}
  </details>;
}

"use client";
import { Component, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import type { BrowserDemoProps } from "./ReplayDemoBrowserSession";
const loadBrowser = () => import("./ReplayDemoBrowserSession").then(module => module.ReplayDemoBrowserSession);
class BrowserBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
/** An intent-only JS island as well as an intent-only worker. The import has
 * a finite local Retry; optional chunk failures cannot take down the homepage. */
export function ReplayDemoBrowserIsland({ loader = loadBrowser, ...props }: BrowserDemoProps & { loader?: typeof loadBrowser }) {
  const [attempt, setAttempt] = useState(0), [loaded, setLoaded] = useState<{ attempt: number; loader: typeof loader; component: ComponentType<BrowserDemoProps> } | null>(null), [failed, setFailed] = useState(false);
  const callbacks = useRef(props); callbacks.current = props;
  useEffect(() => {
    let current = true; setFailed(false); setLoaded(null);
    const timer = setTimeout(() => { if (current) { current = false; setFailed(true); } }, 20_000);
    Promise.resolve().then(loader).then(component => { if (current) { clearTimeout(timer); setLoaded({ attempt, loader, component }); } }).catch(() => { if (current) { clearTimeout(timer); setFailed(true); } });
    return () => { current = false; clearTimeout(timer); };
  }, [loader, attempt]);
  useEffect(() => { if (failed && props.request) callbacks.current.onBusy(props.request, false); }, [failed, props.request]);
  const fileLabel = props.request ? `${props.request.file.name} · ${(props.request.file.size / 1024 / 1024).toFixed(2)} MB` : "";
  const fallback = <Modal open={!!props.request} title="The browser analyzer could not load" onClose={props.onClose}
    footer={<><Button variant="secondary" onClick={props.onClose}>Cancel</Button><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Retry analyzer</Button><Button onClick={props.onChooseAnother}>Choose another replay</Button></>}>
    <p className="mb-3 text-caption text-text-muted [overflow-wrap:anywhere]">{fileLabel}</p>
    <p role="alert">The analyzer did not finish loading. Retry, or use a current Chrome or Edge browser or the desktop app. Your replay has not been uploaded.</p>
  </Modal>;
  const Browser = loaded?.attempt === attempt && loaded.loader === loader ? loaded.component : null;
  return <BrowserBoundary key={attempt} fallback={fallback} onFailure={() => { if (props.request) callbacks.current.onBusy(props.request, false); }}>{failed ? fallback : Browser ? <Browser {...props} /> : <Modal open={!!props.request} title="Loading browser analyzer…" onClose={props.onClose} footer={<Button variant="secondary" onClick={props.onClose}>Cancel</Button>}><p className="mb-3 text-caption text-text-muted [overflow-wrap:anywhere]">{fileLabel}</p><p role="status">Preparing the private analyzer…</p></Modal>}</BrowserBoundary>;
}

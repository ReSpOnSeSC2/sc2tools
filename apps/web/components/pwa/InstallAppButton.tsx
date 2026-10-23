"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { Download } from "lucide-react";
import { useInstallState } from "@/lib/pwa/install";
import { useToastOptional } from "@/components/ui/Toast";
const Instructions = dynamic(() => import("./InstallInstructions").then((module) => module.InstallInstructions), { ssr: false });
export function InstallAppButton({ className = "" }: { className?: string }) {
  const { available, platform, installed, promptInstall } = useInstallState();
  const toast = useToastOptional();
  const [instructions, setInstructions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const visible = !installed && (available || platform.startsWith("ios") || platform === "android");
  const install = async () => {
    if (!available) { setInstructions(true); return; }
    setBusy(true); const outcome = await promptInstall(); setBusy(false);
    if (outcome === "accepted") {
      const text = "SC2 Tools installed. Find it on your home screen or app list.";
      if (toast) toast.toast.success(text); else setMessage(text);
    } else if (outcome === "unavailable" && platform !== "desktop-chromium" && platform !== "unsupported") setInstructions(true);
  };
  return <>{visible ? <button type="button" onClick={() => { void install(); }} disabled={busy} aria-busy={busy} className={`flex min-h-11 items-center gap-3 rounded-lg px-4 py-2 text-caption font-semibold text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}><Download className="h-5 w-5 shrink-0" aria-hidden />Install app</button> : null}{instructions ? <Instructions platform={platform} onClose={() => setInstructions(false)} /> : null}{message ? <p role="status" className="text-caption">{message}</p> : null}</>;
}

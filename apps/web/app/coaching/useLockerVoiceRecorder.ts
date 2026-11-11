"use client";

import { useEffect, useRef, useState } from "react";

export const LOCKER_VOICE_MAX_BYTES = 2.5 * 1024 * 1024;
const MAX_DURATION_MS = 90_000;
const PREFERRED_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];

type Phase = "idle" | "requesting" | "recording";
type Capture = {
  stream?: MediaStream;
  recorder?: MediaRecorder;
  interval?: number;
  timeout?: number;
};

function release(capture: Capture) {
  window.clearInterval(capture.interval);
  window.clearTimeout(capture.timeout);
  const recorder = capture.recorder;
  if (recorder) {
    recorder.onstop = recorder.ondataavailable = recorder.onerror = null;
    if (recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* The device already ended. */ }
    }
  }
  capture.stream?.getTracks().forEach(track => track.stop());
}

/** A recording belongs only to the mounted editor. File attachment remains
 * available when microphone permission or browser recording is unavailable. */
export function useLockerVoiceRecorder(onRecorded: (file: File) => void) {
  const active = useRef<Capture | null>(null);
  const save = useRef(onRecorded);
  save.current = onRecorded;
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");

  function closeCapture(capture: Capture) {
    if (active.current !== capture) return false;
    active.current = null;
    release(capture);
    setPhase("idle");
    setSeconds(0);
    return true;
  }

  function stop() {
    const capture = active.current;
    if (!capture) return;
    if (!capture.recorder) { closeCapture(capture); return; }
    if (capture.recorder.state === "inactive") return;
    try { capture.recorder.stop(); }
    catch { if (closeCapture(capture)) setError("The recording ended unexpectedly. Try again or attach an audio file."); }
  }

  async function start() {
    if (active.current) return;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Microphone recording is unavailable here. Attach an audio file instead.");
      return;
    }
    const capture: Capture = {};
    active.current = capture;
    setPhase("requesting");
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      capture.stream = stream;
      if (active.current !== capture) { release(capture); return; }
      const mimeType = PREFERRED_TYPES.find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48_000 } : undefined);
      capture.recorder = recorder;
      bindCapture(recorder, file => { if (closeCapture(capture)) save.current(file); }, message => {
        if (closeCapture(capture)) setError(message);
      });
      recorder.start(1000);
      const began = Date.now();
      capture.interval = window.setInterval(() => setSeconds(Math.min(90, Math.floor((Date.now() - began) / 1000))), 500);
      capture.timeout = window.setTimeout(stop, MAX_DURATION_MS);
      setPhase("recording");
    } catch {
      if (closeCapture(capture)) setError("Microphone unavailable. Check your permission or attach an audio file instead.");
    }
  }

  useEffect(() => () => {
    const capture = active.current;
    active.current = null;
    if (capture) release(capture);
  }, []);

  return { phase, seconds, error, start, stop };
}

function bindCapture(recorder: MediaRecorder, save: (file: File) => void, fail: (message: string) => void) {
  const chunks: Blob[] = [];
  let size = 0;
  recorder.ondataavailable = ({ data }) => {
    if (!data.size) return;
    size += data.size;
    if (size > LOCKER_VOICE_MAX_BYTES) { fail("The recording exceeded 2.5 MiB. Try a shorter memo."); return; }
    chunks.push(data);
  };
  recorder.onerror = () => fail("The microphone stopped recording. Try again or attach an audio file.");
  recorder.onstop = () => {
    if (!chunks.length) { fail("No audio was recorded. Try again or attach an audio file."); return; }
    const type = recorder.mimeType || chunks[0].type || "audio/webm";
    const extension = type.startsWith("audio/mp4") ? "m4a" : type.startsWith("audio/ogg") ? "ogg" : "webm";
    save(new File(chunks, `voice-memo.${extension}`, { type }));
  };
}

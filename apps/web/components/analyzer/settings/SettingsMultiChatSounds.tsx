"use client";

/**
 * Settings · Overlay · Multi-platform chat · Custom sounds.
 *
 * The streamer's own alert sounds, three ways:
 *   - Link  — paste a direct MP3/OGG link (e.g. a MyInstants sound:
 *     right-click its Download button → Copy link). The clip streams
 *     straight from that host; licensing is the streamer's call.
 *   - Upload — a small audio file (MP3/OGG/WAV ≤ 300 KB) stored by
 *     the API and served to OBS on the overlay-token route.
 *   - Voice line — a typed phrase spoken by the browser's speech
 *     engine (works offline, no licensing).
 *
 * Entries live in the same sound preferences blob as everything else
 * (part of the page's draft/Save flow) and appear in every sound
 * picker alongside the synthesized and bundled-pack sounds.
 */

import { useEffect, useRef, useState } from "react";
import { Link2, Mic, Play, Trash2, Upload } from "lucide-react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { API_BASE, apiCall } from "@/lib/clientApi";
import {
  CUSTOM_SOUNDS_MAX,
  previewSound,
  type ChatSoundConfig,
  type CustomSound,
} from "@/lib/multichat/sound";

const UPLOAD_MAX_BYTES = 300 * 1024;

function newId(): string {
  return `c-${Math.random().toString(36).slice(2, 10)}`;
}

function useBrowserVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}

const KIND_LABEL: Record<CustomSound["kind"], string> = {
  url: "Link",
  upload: "Upload",
  tts: "Voice line",
};

/**
 * Build a config whose upload entries carry a previewable URL —
 * settings knows the overlay token, so it can hit the same serve
 * route the widget uses.
 */
export function previewableSound(
  sound: ChatSoundConfig,
  overlayToken: string | null,
): ChatSoundConfig {
  if (!overlayToken) return sound;
  return {
    ...sound,
    customSounds: sound.customSounds.map((c) =>
      c.kind === "upload" && c.uploadId && !c.url
        ? {
            ...c,
            url: `/v1/multichat/${encodeURIComponent(overlayToken)}/sound/${c.uploadId}`,
          }
        : c,
    ),
  };
}

export function SettingsMultiChatSounds({
  sound,
  onSoundChange,
  overlayToken,
}: {
  sound: ChatSoundConfig;
  onSoundChange: (next: ChatSoundConfig) => void;
  overlayToken: string | null;
}) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const voices = useBrowserVoices();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<"url" | "upload" | "tts">("url");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [voiceName, setVoiceName] = useState("");
  const [busy, setBusy] = useState(false);

  const full = sound.customSounds.length >= CUSTOM_SOUNDS_MAX;

  const add = (entry: CustomSound) => {
    onSoundChange({ ...sound, customSounds: [...sound.customSounds, entry] });
    setLabel("");
    setUrl("");
    setText("");
  };

  const addLink = () => {
    const cleanUrl = url.trim();
    if (!label.trim() || !/^https:\/\//.test(cleanUrl)) {
      toast.error("Link sounds need a name and an https:// audio URL");
      return;
    }
    add({ id: newId(), label: label.trim(), kind: "url", url: cleanUrl });
  };

  const addVoiceLine = () => {
    if (!label.trim() || !text.trim()) {
      toast.error("Voice lines need a name and the phrase to speak");
      return;
    }
    add({
      id: newId(),
      label: label.trim(),
      kind: "tts",
      text: text.trim(),
      voiceName,
      rate: 1,
    });
  };

  const uploadFile = async (file: File) => {
    if (!label.trim()) {
      toast.error("Give the sound a name before choosing the file");
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      toast.error("File too large", {
        description: "Uploads are capped at 300 KB — trim the clip first.",
      });
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const created = await apiCall<{ soundId: string; label: string }>(
        getToken,
        "/v1/me/multichat-sounds",
        {
          method: "POST",
          body: JSON.stringify({
            label: label.trim(),
            dataBase64: btoa(bin),
          }),
        },
      );
      add({
        id: newId(),
        label: created.label,
        kind: "upload",
        uploadId: created.soundId,
      });
      toast.success("Sound uploaded", {
        description: "Remember to Save to put it in your pickers.",
      });
    } catch (e) {
      toast.error("Upload failed", {
        description: e instanceof Error ? e.message : "Try a smaller MP3/OGG/WAV.",
      });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = (entry: CustomSound) => {
    onSoundChange({
      ...sound,
      customSounds: sound.customSounds.filter((c) => c.id !== entry.id),
    });
    if (entry.kind === "upload" && entry.uploadId) {
      // Best-effort server delete — the entry is already out of the
      // config either way; an orphaned file only wastes its own slot.
      void apiCall(getToken, `/v1/me/multichat-sounds/${entry.uploadId}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
  };

  const preview = (entry: CustomSound) => {
    previewSound(
      entry.id,
      sound.eventVolume,
      previewableSound(sound, overlayToken),
      API_BASE,
    );
  };

  return (
    <div className="space-y-3">
      <p className="text-caption text-text-dim">
        Add your own sounds — paste a direct audio link (e.g. from
        MyInstants: right-click the sound&apos;s download button and copy
        the link), upload a small file, or type a phrase to be spoken.
        They show up in every sound picker under <b>Your sounds</b>.
        Anything you add from the internet is used under your own
        licence responsibility — famous clips can also trigger VOD
        muting on Twitch/YouTube.
      </p>

      {sound.customSounds.length > 0 ? (
        <ul className="space-y-1.5">
          {sound.customSounds.map((c) => (
            <li
              key={c.id}
              className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-bg-elevated px-2.5 py-1.5"
            >
              <span className="rounded bg-bg-surface px-1.5 py-0.5 text-micro font-semibold uppercase tracking-wider text-text-muted">
                {KIND_LABEL[c.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate text-caption text-text">
                {c.label}
              </span>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Preview ${c.label}`}
                onClick={() => preview(c)}
              >
                <Play className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <button
                type="button"
                aria-label={`Remove ${c.label}`}
                onClick={() => remove(c)}
                className="rounded border border-border p-1.5 text-text-muted hover:border-danger hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {full ? (
        <p className="text-caption text-warning">
          Limit of {CUSTOM_SOUNDS_MAX} custom sounds reached — remove one
          to add another.
        </p>
      ) : (
        <div className="space-y-2 rounded-md border border-border p-2.5">
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["url", "Link", Link2],
                ["upload", "Upload", Upload],
                ["tts", "Voice line", Mic],
              ] as const
            ).map(([m, lbl, Icon]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-caption ${
                  mode === m
                    ? "border-accent text-text"
                    : "border-border text-text-muted hover:text-text"
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {lbl}
              </button>
            ))}
          </div>

          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Sound name (shown in pickers)"
            maxLength={40}
            className="w-full min-w-0 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />

          {mode === "url" ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…/sound.mp3"
                maxLength={400}
                className="min-w-0 flex-1 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <Button size="sm" variant="secondary" onClick={addLink}>
                Add link
              </Button>
            </div>
          ) : null}

          {mode === "upload" ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadFile(f);
                }}
                className="text-caption text-text-muted file:mr-2 file:rounded-md file:border file:border-border file:bg-bg-elevated file:px-2.5 file:py-1 file:text-caption file:text-text"
              />
              <span className="text-micro text-text-dim">
                MP3/OGG/WAV, max 300 KB, up to 5 uploads
              </span>
            </div>
          ) : null}

          {mode === "tts" ? (
            <div className="space-y-2">
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder='Phrase to speak, e.g. "New sub! Welcome aboard!"'
                maxLength={200}
                className="w-full min-w-0 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                  aria-label="Voice for this line"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-text focus:border-accent focus:outline-none"
                >
                  <option value="">Machine default voice</option>
                  {voices.map((v) => (
                    <option key={`${v.name}|${v.lang}`} value={v.name}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="secondary" onClick={addVoiceLine}>
                  Add voice line
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

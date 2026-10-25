"use client";

import type { KeyboardEvent, RefObject } from "react";
import { adjacentReplayMarker, adjacentReplaySpeed, type ReplaySpeed } from "./replayControls";

type Controls = {
  root: RefObject<HTMLElement | null>;
  time: number;
  gameLength: number;
  playing: boolean;
  speed: ReplaySpeed;
  markers: readonly { t: number }[];
  onSeek: (time: number) => void;
  onPlay: (playing: boolean) => void;
  onSpeed: (speed: ReplaySpeed) => void;
  onMusic: () => void;
  onHelp: () => void;
  helpOpen: boolean;
};

export function useReplayShortcuts(controls: Controls) {
  return (event: KeyboardEvent<HTMLElement>) => {
    const { root, time, gameLength, playing, speed, markers, onSeek, onPlay, onSpeed, onMusic, onHelp } = controls;
    const target = event.target;
    // Native controls retain their keys, including Space on buttons and arrows on sliders.
    if (controls.helpOpen || event.defaultPrevented || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || !(target instanceof Element) || !root.current?.contains(target) || target.closest("input,textarea,select,button,a,summary,[contenteditable]:not([contenteditable='false']),[role='dialog'],[role='menu'],[role='listbox'],[data-replay-popover]")) return;
    const key = event.key.toLowerCase();
    const seek = (value: number) => onSeek(Math.max(0, Math.min(gameLength, value)));
    const repeatable = ["arrowleft", "arrowright", "j", "l", ",", "."].includes(key);
    if (event.repeat && !repeatable) return;
    switch (key) {
      case " ": case "k": if (!playing && time >= gameLength) seek(0); onPlay(!playing); break;
      case "j": seek(time - 10); break;
      case "l": seek(time + 10); break;
      case "arrowleft": seek(time - (event.shiftKey ? 5 : 1)); break;
      case "arrowright": seek(time + (event.shiftKey ? 5 : 1)); break;
      case ",": case ".": if (playing) return; seek(time + (key === "." ? 1 : -1) / 22.4); break;
      case "[": onSpeed(adjacentReplaySpeed(speed, -1)); break;
      case "]": onSpeed(adjacentReplaySpeed(speed, 1)); break;
      case "home": seek(0); break;
      case "end": seek(gameLength); break;
      case "n": case "p": { const next = adjacentReplayMarker(markers, time, key === "n" ? 1 : -1); if (next !== null) seek(next); break; }
      case "m": onMusic(); break;
      case "?": onHelp(); break;
      case "f": {
        const request = document.fullscreenElement ? document.exitFullscreen?.() : root.current.requestFullscreen?.();
        void request?.catch(() => { /* Browser fullscreen may be unavailable. */ });
        break;
      }
      default: if (/^[0-9]$/.test(key)) seek(gameLength * Number(key) / 10); else return;
    }
    event.preventDefault();
  };
}

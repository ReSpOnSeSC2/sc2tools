// These aliases exist ONLY in server.mjs; production imports stay untouched.
import { ENGAGEMENT, MESSAGES, STUDIO } from "./fixtures";
export * from "fixture-original:studio";
export * from "fixture-original:engagement";
export * from "fixture-original:refresh";
export * from "fixture-original:maps";

export const API_BASE = "/fixture-api";
export function useStudioState() { return STUDIO; }
export function useTestFireFlag() { return true; }
export function useEngagementState() { return { summary: ENGAGEMENT, lastEvent: null }; }
export function useMultiChat() { return { messages: MESSAGES, events: [], statuses: { twitch: { state: "connected" }, kick: { state: "connected" }, youtube: { state: "connected" }, tiktok: { state: "connected" } }, active: true }; }
export function useTickerFacts() { return []; }
export function useEngagementReporter() {}
export function useChatSound() {}
export function useChatTts() { return { needsGesture: false, onUserGesture() {} }; }
export function useEventSounds() {}
export function useOverlayAlertMediaGrant() {}
export function useCommandAnswers() { return null; }
export function useTranslation() { return {}; }
export function useOverlayBuildRefresh() {}
export function useWidgetAudioOwner() { return false; }
export function useSpeechSynthesisIdle() { return true; }
export function setRevealSoundEnabled() {}
export function setRevealSoundVolume() {}
export function useRevealAudioUnlock() {}
export function useRevealSound() {}
export function playSoundtrack() { return () => {}; }
// Map thumbnails normally come from the account API. Exercise the real
// artwork component's built-in fallback rather than requesting that API.
export function getMapImageUrl() { return null; }
export function getMapLayoutUrl() { return null; }

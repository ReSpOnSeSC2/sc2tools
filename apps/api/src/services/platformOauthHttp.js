"use strict";

/**
 * Shared HTTP primitives for the official platform OAuth clients.
 *
 * Every provider call goes through `fetchJson` or `fetchNoContent` so a
 * provider can never stall a request indefinitely or stream an unbounded body
 * into memory, and so a failure always arrives as a `PlatformOauthError`
 * carrying the provider's status. Split out of `platformOauthClients` so the
 * Twitch EventSub reconciler can reuse them without importing every provider.
 */

const REQUEST_TIMEOUT_MS = 12_000;
const JSON_MAX_BYTES = 512 * 1024;

class PlatformOauthError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 502) {
    super(message);
    this.name = "PlatformOauthError";
    this.code = code;
    this.status = status;
  }
}

/** @param {typeof fetch} fetchImpl @param {string} url @param {Record<string,string>} fields @param {string} code */
async function postForm(fetchImpl, url, fields, code) {
  return fetchJson(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    code,
  );
}

/** @param {typeof fetch} fetchImpl @param {string} url @param {RequestInit} init @param {string} code */
async function fetchJson(fetchImpl, url, init, code) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PlatformOauthError(code, `${code} request failed: ${safeError(err)}`);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = await readBoundedText(response, JSON_MAX_BYTES);
      const parsed = JSON.parse(body);
      detail = String(parsed.message || parsed.error_description || parsed.error || "").slice(0, 160);
    } catch {
      detail = "";
    }
    throw new PlatformOauthError(
      code,
      `${code} returned ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  const body = await readBoundedText(response, JSON_MAX_BYTES);
  try {
    return JSON.parse(body);
  } catch {
    throw new PlatformOauthError(code, `${code} returned invalid JSON`);
  }
}

/** @param {typeof fetch} fetchImpl @param {string} url @param {RequestInit} init @param {string} code */
async function fetchNoContent(fetchImpl, url, init, code) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PlatformOauthError(code, `${code} request failed: ${safeError(err)}`);
  }
  if (response.ok) return;
  let detail = "";
  try {
    const body = await readBoundedText(response, JSON_MAX_BYTES);
    try {
      const parsed = JSON.parse(body);
      detail = String(parsed.message || parsed.error_description || parsed.error || "");
    } catch {
      detail = body;
    }
  } catch {
    detail = "";
  }
  throw new PlatformOauthError(
    code,
    `${code} returned ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
    response.status,
  );
}

/** @param {Response} response @param {number} maxBytes */
async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) throw new Error("response_too_large");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("response_too_large");
  return text;
}

/** @param {unknown} err */
function safeError(err) {
  return err instanceof Error ? err.name : "network error";
}

/** @param {unknown} err */
function safeMessage(err) {
  return (err instanceof Error ? err.message : String(err || "")).slice(0, 200);
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  JSON_MAX_BYTES,
  PlatformOauthError,
  postForm,
  fetchJson,
  fetchNoContent,
  readBoundedText,
  safeError,
  safeMessage,
};

/**
 * LMArena API — payload construction, response parsing, direct HTTP requests.
 */

import { uuidv7 } from "../utils/uuid.js";
import { debug } from "../utils/logger.js";
import {
  ARENA_BASE_URL,
  STREAM_CREATE_PATH,
  STREAM_RETRY_PATH_PREFIX,
  UPSTREAM_TIMEOUT_MS,
  AUTH_COOKIE_NAME,
} from "../constants.js";
import type { Config } from "../config.js";

// ---------- Payload ----------

export interface LMArenaPayload {
  id: string;
  mode?: string;
  modelAId: string;
  userMessageId: string;
  modelAMessageId: string;
  modelBMessageId: string;
  userMessage: {
    content: string;
    experimental_attachments?: unknown[];
    metadata?: Record<string, unknown>;
  };
  modality: string;
  recaptchaV3Token: string;
}

export function buildCreatePayload(
  modelId: string,
  content: string,
  recaptchaToken: string
): { payload: LMArenaPayload; url: string; method: string } {
  const sessionId = uuidv7();
  return {
    payload: {
      id: sessionId,
      mode: "direct-battle",
      modelAId: modelId,
      userMessageId: uuidv7(),
      modelAMessageId: uuidv7(),
      modelBMessageId: uuidv7(),
      userMessage: { content, experimental_attachments: [], metadata: {} },
      modality: "chat",
      recaptchaV3Token: recaptchaToken,
    },
    url: `${ARENA_BASE_URL}${STREAM_CREATE_PATH}`,
    method: "POST",
  };
}

export function buildFollowupPayload(
  conversationId: string,
  modelId: string,
  content: string,
  recaptchaToken: string
): { payload: LMArenaPayload; url: string; method: string } {
  return {
    payload: {
      id: conversationId,
      modelAId: modelId,
      userMessageId: uuidv7(),
      modelAMessageId: uuidv7(),
      modelBMessageId: uuidv7(),
      userMessage: { content, experimental_attachments: [], metadata: {} },
      modality: "chat",
      recaptchaV3Token: recaptchaToken,
    },
    url: `${ARENA_BASE_URL}${STREAM_CREATE_PATH}`,
    method: "POST",
  };
}

export function buildRetryPayload(
  conversationId: string,
  messageId: string
): { url: string; method: string; payload: Record<string, never> } {
  return {
    url: `${ARENA_BASE_URL}${STREAM_RETRY_PATH_PREFIX}/${conversationId}/messages/${messageId}`,
    method: "PUT",
    payload: {},
  };
}

// ---------- Response parsing ----------

export interface ParsedResponse {
  text: string;
  reasoning: string;
  finishReason: string | null;
  error: string | null;
}

/** Parse LMArena's custom streaming format: a0:"text", ag:"thinking", ad:{...} */
export function parseLMArenaBody(body: string): ParsedResponse {
  let text = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let errorMsg: string | null = null;

  for (let raw of body.split("\n")) {
    let line = raw.trim();
    if (line.startsWith("data: ")) line = line.slice(6).trim();
    if (!line) continue;

    // Text chunk
    if (line.startsWith("a0:")) {
      try {
        text += JSON.parse(line.slice(3));
      } catch {}
    }
    // Thinking/reasoning
    else if (line.startsWith("ag:")) {
      try {
        reasoning += JSON.parse(line.slice(3));
      } catch {}
    }
    // Metadata (finish reason, etc.)
    else if (line.startsWith("ad:")) {
      try {
        const meta = JSON.parse(line.slice(3));
        if (meta.finishReason) finishReason = meta.finishReason;
      } catch {}
    }
    // Citations
    else if (line.startsWith("ac:")) {
      // Citations parsed but not surfaced in basic text response
    }
    // Image
    else if (line.startsWith("a2:")) {
      try {
        const imgs = JSON.parse(line.slice(3));
        if (Array.isArray(imgs) && imgs[0]?.type === "image") {
          text = `![Generated Image](${imgs[0].image})`;
        }
      } catch {}
    }
    // Error in body
    else if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line);
        if (obj.error) errorMsg = typeof obj.error === "string" ? obj.error : obj.error.message;
      } catch {}
    }
  }

  return { text, reasoning, finishReason, error: errorMsg };
}

// ---------- HTTP helpers ----------

export function buildRequestHeaders(
  token: string,
  recaptchaToken: string,
  config: Config
): Record<string, string> {
  const cookies: string[] = [];
  const add = (name: string, val?: string) => {
    if (val?.trim()) cookies.push(`${name}=${val.trim()}`);
  };
  add("cf_clearance", config.cf_clearance as string);
  add("__cf_bm", config.cf_bm as string);
  add("_cfuvid", config.cfuvid as string);
  add("provisional_user_id", config.provisional_user_id as string);
  if (token) add(AUTH_COOKIE_NAME, token);

  const headers: Record<string, string> = {
    "Content-Type": "text/plain;charset=UTF-8",
    Cookie: cookies.join("; "),
    Origin: ARENA_BASE_URL,
    Referer: `${ARENA_BASE_URL}/?mode=direct`,
  };
  if (config.user_agent) headers["User-Agent"] = config.user_agent;
  if (recaptchaToken) {
    headers["X-Recaptcha-Token"] = recaptchaToken;
    headers["X-Recaptcha-Action"] =
      (config.recaptcha_action as string) ?? "chat_submit";
  }
  return headers;
}

/** Direct HTTP POST to LMArena (non-browser). Returns raw response text. */
export async function directRequest(
  url: string,
  method: string,
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      body,
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared HTTP request handler with retry + reCAPTCHA refresh logic.
 * Both chat.ts and messages.ts use this to talk to LMArena.
 */

import { mintRecaptchaToken } from "./browser.js";
import { buildRequestHeaders, directRequest, parseLMArenaBody } from "./lmarena.js";
import type { LMArenaPayload } from "./lmarena.js";
import { clearRecaptchaToken } from "../state.js";
import { debug } from "../utils/logger.js";
import type { Config } from "../config.js";
import type { ParsedResponse } from "./lmarena.js";

export interface ArenaRequestResult {
  status: number;
  text: string;
  parsed: ParsedResponse;
}

/**
 * Make an HTTP request to LMArena with automatic reCAPTCHA refresh on 403
 * and retry on 429.
 *
 * Always mints a fresh reCAPTCHA token before each attempt (tokens are single-use).
 *
 * @param payload - The LMArena request payload (recaptchaV3Token will be overwritten each attempt)
 */
export async function directRequestWithRetry(
  url: string,
  method: string,
  payload: LMArenaPayload,
  token: string,
  config: Config,
  maxRetries: number = 3,
): Promise<ArenaRequestResult> {
  let lastStatus = 0;
  let lastText = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Mint fresh reCAPTCHA token — tokens are single-use
    clearRecaptchaToken();
    const recaptchaToken = (await mintRecaptchaToken()) ?? "";
    payload.recaptchaV3Token = recaptchaToken;

    const headers = buildRequestHeaders(token, recaptchaToken, config);
    let status: number;
    let text: string;
    try {
      ({ status, text } = await directRequest(url, method, JSON.stringify(payload), headers));
    } catch (e) {
      debug(`Network error on attempt ${attempt + 1}: ${e}`);
      lastStatus = 0;
      lastText = `Network error: ${e}`;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      break;
    }
    lastStatus = status;
    lastText = text;

    if (status === 200) {
      const parsed = parseLMArenaBody(text);
      if (!parsed.error) {
        return { status, text, parsed };
      }
      debug(`LMArena returned 200 but parsed error: ${parsed.error}`);
    } else if (status === 401) {
      debug("Auth token expired (401)");
      break;
    } else if (status === 403) {
      const isRecaptcha = text.includes("recaptcha validation failed");
      if (isRecaptcha && attempt < maxRetries - 1) {
        debug(`reCAPTCHA failed, retrying (${attempt + 1}/${maxRetries})...`);
        continue;
      }
      debug(`HTTP 403: ${text.slice(0, 200)}`);
      break;
    } else if (status === 429) {
      if (attempt < maxRetries - 1) {
        debug(`Rate limited (429), waiting 5s before retry...`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      debug(`HTTP 429: retry limit reached`);
    } else {
      debug(`HTTP ${status}: ${text.slice(0, 200)}`);
      break;
    }
  }

  const parsed = parseLMArenaBody(lastText);
  return { status: lastStatus, text: lastText, parsed };
}

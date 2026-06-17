/** All hardcoded constants for the LMArena Bridge. */

export const PORT = 8000;

// LMArena endpoints
export const ARENA_BASE_URL = "https://arena.ai";
export const STREAM_CREATE_PATH = "/nextjs-api/stream/create-evaluation";
export const STREAM_RETRY_PATH_PREFIX =
  "/nextjs-api/stream/retry-evaluation-session-message";

// reCAPTCHA
export const RECAPTCHA_SITEKEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0";
export const RECAPTCHA_ACTION = "chat_submit";
export const RECAPTCHA_TOKEN_TTL_MS = 110_000;

// Cloudflare Turnstile
export const TURNSTILE_SITEKEY = "0x4AAAAAAA65vWDmG-O_lPtT";
export const TURNSTILE_MAX_CLICKS = 15;

// Timeouts (ms)
export const STARTUP_NAV_TIMEOUT_MS = 90_000;
export const RECAPTCHA_MINT_TIMEOUT_MS = 70_000;
export const UPSTREAM_TIMEOUT_MS = 25_000;

// Auth
export const AUTH_COOKIE_NAME = "arena-auth-prod-v1";
export const TOKEN_REFRESH_SKEW_SEC = 30;

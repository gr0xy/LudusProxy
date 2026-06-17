/**
 * Shared mutable state — in-memory only, not persisted.
 */

/** Round-robin pointer for auth tokens. */
export let currentTokenIndex = 0;

export function advanceTokenIndex(total: number): number {
  if (total > 0) currentTokenIndex = (currentTokenIndex + 1) % total;
  return currentTokenIndex;
}

export function resetTokenIndex(): void {
  currentTokenIndex = 0;
}

// reCAPTCHA cache
export let RECAPTCHA_TOKEN: string | null = null;
export let RECAPTCHA_EXPIRY: number = 0; // epoch ms

export function setRecaptchaToken(token: string, _action: string, ttlMs: number) {
  RECAPTCHA_TOKEN = token;
  RECAPTCHA_EXPIRY = Date.now() + ttlMs;
}

export function clearRecaptchaToken() {
  RECAPTCHA_TOKEN = null;
  RECAPTCHA_EXPIRY = 0;
}

export function isRecaptchaValid(): boolean {
  return !!RECAPTCHA_TOKEN && Date.now() < RECAPTCHA_EXPIRY - 10_000;
}

/**
 * Auth token management — JWT decode, expiry check, round-robin, Supabase refresh.
 */

import { getConfig, saveConfig, CONFIG_FILE, type Config } from "../config.js";
import {
  currentTokenIndex,
  advanceTokenIndex,
} from "../state.js";
import { debug, error } from "../utils/logger.js";
import { AUTH_COOKIE_NAME, TOKEN_REFRESH_SKEW_SEC } from "../constants.js";

// ---------- JWT helpers ----------

function base64UrlDecode(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf-8");
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

/** Decode a base64-encoded Supabase session (arena-auth-prod-v1 format). */
export function decodeSession(
  token: string
): { access_token: string; refresh_token?: string; expires_at?: number } | null {
  if (!token.startsWith("base64-")) return null;
  try {
    const raw = base64UrlDecode(token.slice(7));
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && obj.access_token) return obj;
    return null;
  } catch {
    return null;
  }
}

// ---------- Token validation ----------

export function getTokenExpiry(token: string): number | null {
  // Try base64 session
  const session = decodeSession(token);
  if (session?.expires_at) return session.expires_at;
  if (session?.access_token) {
    const payload = decodeJwtPayload(session.access_token);
    if (payload?.exp) return payload.exp as number;
  }
  // Try raw JWT
  const payload = decodeJwtPayload(token);
  if (payload?.exp) return payload.exp as number;
  return null;
}

export function isTokenExpired(token: string, skewSec = TOKEN_REFRESH_SKEW_SEC): boolean {
  const exp = getTokenExpiry(token);
  if (exp === null) return false; // unknown format → don't assume expired
  return Date.now() / 1000 >= exp - skewSec;
}

export function isProbablyValid(token: string): boolean {
  if (!token) return false;
  if (token.startsWith("base64-")) return !!decodeSession(token);
  if (token.includes(".")) return !!decodeJwtPayload(token);
  return token.length >= 50; // opaque long token
}

// ---------- Token selection ----------

export function getAuthToken(cfg?: Config): string {
  const config = cfg ?? getConfig();
  const tokens = (config.auth_tokens ?? [])
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    // Legacy single token fallback
    const legacy = (config.auth_token ?? "").trim();
    if (legacy) return legacy;
    return "";
  }

  // Prefer valid, non-expired tokens
  const valid = tokens.filter((t) => !isTokenExpired(t));
  const pool = valid.length > 0 ? valid : tokens;

  // Round-robin
  const idx = currentTokenIndex % pool.length;
  advanceTokenIndex(pool.length);
  return pool[idx];
}

export function getAuthHeaderValue(token: string): string {
  if (!token) return "";
  return `${AUTH_COOKIE_NAME}=${token}`;
}

// ---------- Supabase token refresh ----------

/** Derive Supabase Auth base URL from JWT iss claim. */
function deriveSupabaseAuthUrl(token: string): string | null {
  const session = decodeSession(token);
  if (!session?.access_token) return null;
  const payload = decodeJwtPayload(session.access_token);
  if (!payload) return null;
  const iss = String(payload.iss ?? "");
  if (!iss) return null;
  // iss is typically https://<ref>.supabase.co/auth/v1
  if (iss.includes("/auth/v1")) return iss.split("/auth/v1")[0] + "/auth/v1";
  return iss;
}

/** Try to refresh an expired token via Supabase. Returns new token or null. */
export async function refreshExpiredToken(): Promise<string | null> {
  const cfg = getConfig();
  const tokens = (cfg.auth_tokens ?? []).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;

  for (const oldToken of tokens) {
    if (!isTokenExpired(oldToken, 0)) continue; // not expired, skip

    const session = decodeSession(oldToken);
    if (!session?.refresh_token) continue;

    const authBase = deriveSupabaseAuthUrl(oldToken);
    if (!authBase) continue;

    // Try to get Supabase anon key from config
    const anonKey = String((cfg as any).supabase_anon_key ?? "").trim();
    if (!anonKey) {
      debug("No supabase_anon_key in config, skipping token refresh");
      continue;
    }

    const url = `${authBase}/token?grant_type=refresh_token`;
    const headers = {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    try {
      debug("Attempting Supabase token refresh...");
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ refresh_token: session.refresh_token }),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status !== 200) {
        debug(`Supabase refresh failed: HTTP ${res.status}`);
        continue;
      }

      const data = (await res.json()) as Record<string, unknown>;
      if (!data || typeof data !== "object") continue;

      // Merge new values into session
      const updated = { ...session };
      for (const key of ["access_token", "refresh_token", "expires_in", "expires_at", "token_type"]) {
        if (data[key] != null) (updated as any)[key] = data[key];
      }

      // Re-encode to base64
      const newBase64 = "base64-" + Buffer.from(JSON.stringify(updated)).toString("base64");

      // Update config
      const idx = cfg.auth_tokens.indexOf(oldToken);
      if (idx >= 0) {
        cfg.auth_tokens[idx] = newBase64;
        saveConfig(cfg);
        debug("Token refreshed and saved to config");
        return newBase64;
      }
    } catch (e) {
      error("Supabase refresh error:", e);
    }
  }

  return null;
}

/** Ensure we have a valid non-expired token, refreshing if needed. Returns token or empty string. */
export async function ensureValidToken(): Promise<string> {
  const cfg = getConfig();
  const tokens = (cfg.auth_tokens ?? []).map((t) => t.trim()).filter(Boolean);

  // Check if any non-expired token exists
  const valid = tokens.filter((t) => !isTokenExpired(t));
  if (valid.length > 0) return valid[0];

  // All expired — try LMArena HTTP refresh first (no anon key needed)
  const httpRefreshed = await refreshTokenViaLMArena();
  if (httpRefreshed) return httpRefreshed;

  // Try Supabase refresh
  const supabaseRefreshed = await refreshExpiredToken();
  if (supabaseRefreshed) return supabaseRefreshed;

  // Refresh failed — return expired token anyway (better than nothing)
  return tokens[0] ?? "";
}

/**
 * Refresh token via LMArena HTTP — navigate to arena.ai with expired token cookie,
 * LMArena rotates the session and returns a new token via Set-Cookie.
 */
export async function refreshTokenViaLMArena(): Promise<string | null> {
  const cfg = getConfig();
  const oldToken = (cfg.auth_tokens ?? [])[0]?.trim();
  if (!oldToken?.startsWith("base64-")) return null;

  debug("Attempting LMArena HTTP token refresh...");

  try {
    // Build cookie string for the request
    const cookies: string[] = [];
    if (cfg.cf_clearance) cookies.push(`cf_clearance=${cfg.cf_clearance}`);
    if (cfg.cf_bm) cookies.push(`__cf_bm=${cfg.cf_bm}`);
    if (cfg.cfuvid) cookies.push(`_cfuvid=${cfg.cfuvid}`);
    if (cfg.provisional_user_id) cookies.push(`provisional_user_id=${cfg.provisional_user_id}`);
    cookies.push(`arena-auth-prod-v1=${oldToken}`);

    const res = await fetch("https://arena.ai/", {
      method: "GET",
      headers: {
        "User-Agent": cfg.user_agent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Cookie": cookies.join("; "),
        "Accept": "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });

    // Look for refreshed arena-auth-prod-v1 in Set-Cookie headers
    const setCookies = res.headers.getSetCookie?.() ?? [];
    let newToken: string | null = null;

    // Handle split cookies (.0 + .1)
    const chunks: { idx: number; value: string }[] = [];
    for (const sc of setCookies) {
      const [nameValue] = sc.split(";");
      const eqIdx = nameValue.indexOf("=");
      if (eqIdx < 0) continue;
      const name = nameValue.slice(0, eqIdx).trim();
      const value = nameValue.slice(eqIdx + 1).trim();
      if (!value) continue;

      if (name === "arena-auth-prod-v1") {
        newToken = value;
      } else if (name.startsWith("arena-auth-prod-v1.")) {
        const idx = parseInt(name.split(".")[1]);
        if (!isNaN(idx)) chunks.push({ idx, value });
      }
    }

    // Reassemble split cookies
    if (!newToken && chunks.length > 0) {
      chunks.sort((a, b) => a.idx - b.idx);
      newToken = chunks.map((c) => c.value).join("");
    }

    if (newToken && newToken !== oldToken) {
      const idx = cfg.auth_tokens.indexOf(oldToken);
      if (idx >= 0) {
        cfg.auth_tokens[idx] = newToken;
        saveConfig(cfg);
        debug("Token refreshed via LMArena HTTP and saved");
        return newToken;
      }
    }

    debug("LMArena HTTP refresh: no new token in Set-Cookie");
    return null;
  } catch (e) {
    debug("LMArena HTTP refresh failed:", e);
    return null;
  }
}

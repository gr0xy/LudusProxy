/**
 * Configuration management — reads/writes config.json with in-memory cache.
 */

import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONFIG_FILE = join(__dirname, "..", "config.json");

export interface ApiKey {
  name: string;
  key: string;
  rpm: number;
  created: string;
}

export interface Config {
  auth_tokens: string[];
  auth_token?: string; // legacy single-token
  api_keys: ApiKey[];
  password?: string;
  cf_clearance?: string;
  cf_bm?: string;
  cfuvid?: string;
  provisional_user_id?: string;
  recaptcha_sitekey?: string;
  recaptcha_action?: string;
  user_agent?: string;
  models?: Array<{
    publicName: string;
    id: string;
    organization?: string;
    capabilities?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
}

const DEFAULTS: Partial<Config> = {
  auth_tokens: [],
  api_keys: [],
};

// ---------- In-memory cache ----------

let _configCache: Config | null = null;
let _configMtime: number = 0;

/**
 * Returns config from disk cache. Re-reads only if the file's mtime changed.
 * Cache is invalidated on every saveConfig/patchConfig call.
 */
export function getConfig(): Config {
  if (_configCache) {
    try {
      const mt = statSync(CONFIG_FILE).mtimeMs;
      if (mt === _configMtime) return _configCache;
    } catch {
      // file deleted or inaccessible → reload
    }
  }

  try {
    if (!existsSync(CONFIG_FILE)) {
      const cfg = { ...DEFAULTS } as Config;
      _configCache = cfg;
      return cfg;
    }
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const cfg = { ...DEFAULTS, ...JSON.parse(raw) } as Config;
    _configCache = cfg;
    _configMtime = statSync(CONFIG_FILE).mtimeMs;
    return cfg;
  } catch {
    const cfg = { ...DEFAULTS } as Config;
    _configCache = cfg;
    return cfg;
  }
}

/** Invalidate cache so next getConfig() re-reads from disk. */
function invalidateCache(): void {
  _configCache = null;
  _configMtime = 0;
}

export function saveConfig(cfg: Config): void {
  try {
    const tmp = CONFIG_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
    renameSync(tmp, CONFIG_FILE);
    invalidateCache();
  } catch (e) {
    console.error("Failed to save config:", e);
  }
}

/** Merge discovered values into config and persist. */
export function patchConfig(patch: Partial<Config>): Config {
  const cfg = getConfig();
  Object.assign(cfg, patch);
  saveConfig(cfg);
  return cfg;
}

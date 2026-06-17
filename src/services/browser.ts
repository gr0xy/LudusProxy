/**
 * Browser management — Playwright Firefox with anti-fingerprinting.
 *
 * Uses Firefox by default (best anti-detection). If Camoufox Python package is
 * installed, the `firefox.launchExecutablePath` config can point to its binary.
 */

import { firefox, type Browser, type BrowserContext, type Page } from "playwright";
import { existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { debug, error } from "../utils/logger.js";
import { getConfig, saveConfig } from "../config.js";
import {
  RECAPTCHA_SITEKEY,
  RECAPTCHA_ACTION,
  RECAPTCHA_TOKEN_TTL_MS,
  TURNSTILE_MAX_CLICKS,
  STARTUP_NAV_TIMEOUT_MS,
  ARENA_BASE_URL,
} from "../constants.js";
import { setRecaptchaToken, clearRecaptchaToken, isRecaptchaValid, RECAPTCHA_TOKEN } from "../state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(__dirname, "..", "..", "browser_profile");

// ---------- Camoufox detection ----------

function findCamoufoxBinary(): string | null {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "camoufox", "camoufox.exe"),
    join(process.env.APPDATA ?? "", "camoufox", "camoufox.exe"),
    join(PROFILE_DIR, "camoufox.exe"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------- Browser launch ----------

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;

export async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;

  const camoufoxPath = findCamoufoxBinary();
  if (camoufoxPath) {
    debug("Launching Camoufox (patched Firefox)");
    _browser = await firefox.launch({
      executablePath: camoufoxPath,
      headless: true,
      args: ["--no-remote"],
    });
  } else {
    debug("Launching Playwright Firefox (no Camoufox found)");
    _browser = await firefox.launch({
      headless: true,
      firefoxUserPrefs: {
        "dom.webdriver.enabled": false,
        "useAutomationExtension": false,
      },
    });
  }
  return _browser;
}

export async function getContext(): Promise<BrowserContext> {
  // Validate that the existing context is still usable
  if (_context) {
    try {
      const browser = _context.browser();
      if (browser?.isConnected()) return _context;
    } catch {}
    _context = null;
  }

  const browser = await getBrowser();
  const cfg = getConfig();
  _context = await browser.newContext({
    userAgent: cfg.user_agent || undefined,
    viewport: { width: 1280, height: 720 },
  });

  // Stealth: hide webdriver property
  await _context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return _context;
}

/**
 * Extract all cookies for arena.ai from the browser context.
 * Used to inject into direct HTTP requests so they have the same
 * cookie state as the browser.
 */
export async function getArenaCookies(): Promise<string> {
  if (!_context) return "";
  try {
    const cookies = await _context.cookies(ARENA_BASE_URL);
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

export async function closeBrowser(): Promise<void> {
  try { await _mintPage?.close(); } catch {}
  _mintPage = null;
  try { await _context?.close(); } catch {}
  try { await _browser?.close(); } catch {}
  _context = null;
  _browser = null;
}

// ---------- Turnstile ----------

async function resolveTurnstile(page: Page): Promise<void> {
  for (let i = 0; i < TURNSTILE_MAX_CLICKS; i++) {
    const title = await page.title();
    if (!title.includes("Just a moment")) {
      debug(`Turnstile resolved (title: ${title.slice(0, 40)}...)`);
      return;
    }
    debug(`Turnstile attempt ${i + 1}/${TURNSTILE_MAX_CLICKS}`);
    try {
      const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
      const checkbox = frame.locator("input[type=checkbox], .cb-lb");
      if ((await checkbox.count()) > 0) {
        await checkbox.first().click({ timeout: 2000 });
      }
    } catch {}
    await page.waitForTimeout(2000);
  }
  debug("Turnstile: max attempts reached");
}

// ---------- reCAPTCHA minting ----------

let _mintPage: Page | null = null;

/**
 * Ensure we have a live mint page on arena.ai.
 * On first call: creates page, navigates, resolves Turnstile, injects scripts.
 * On subsequent calls: reloads the page to clear DOM/JS state while keeping
 * context cookies (cf_clearance), so Turnstile auto-resolves.
 */
async function getMintPage(): Promise<Page> {
  const cfg = getConfig();

  // First time — create page and do full setup
  if (!_mintPage || _mintPage.isClosed()) {
    const context = await getContext();

    if (cfg.cf_clearance) {
      await context.addCookies([{
        name: "cf_clearance",
        value: cfg.cf_clearance,
        domain: ".arena.ai",
        path: "/",
      }]);
    }

    _mintPage = await context.newPage();
    await _mintPage.goto(`${ARENA_BASE_URL}/?mode=direct`, {
      waitUntil: "domcontentloaded",
      timeout: STARTUP_NAV_TIMEOUT_MS,
    });
    await resolveTurnstile(_mintPage);

    // Warm-up: wait for page to settle and age the fingerprint.
    // reCAPTCHA v3 scores improve when the page has been alive longer
    // and has some DOM activity. Without this, the first mint gets rejected.
    await _mintPage.waitForTimeout(3000);
    // Simulate genuine user activity — scroll, mouse movement
    await _mintPage.mouse.move(640, 360);
    await _mintPage.waitForTimeout(500);
    await _mintPage.mouse.move(400, 200);
    await _mintPage.waitForTimeout(500);
    await _mintPage.evaluate(() => window.scrollBy(0, 200));
    await _mintPage.waitForTimeout(1500);
    await _mintPage.evaluate(() => window.scrollBy(0, -100));
    await _mintPage.waitForTimeout(1500);
    await _mintPage.mouse.move(300, 150);
    await _mintPage.waitForTimeout(1000);

    debug("Mint page created on arena.ai");
  } else {
    // Navigate to a neutral page first to reset reCAPTCHA scoring context,
    // then back to arena.ai. This prevents the reCAPTCHA server from seeing
    // rapid repeated token requests from the same page context.
    await _mintPage.goto("about:blank", { timeout: 5000 });
    await _mintPage.waitForTimeout(1000);
    await _mintPage.goto(`${ARENA_BASE_URL}/?mode=direct`, {
      waitUntil: "domcontentloaded",
      timeout: STARTUP_NAV_TIMEOUT_MS,
    });
    // Turnstile won't re-appear because cf_clearance cookie is in context
    await resolveTurnstile(_mintPage);
    debug("Mint page refreshed (neutral navigate)");
  }

  // Wait for reCAPTCHA library
  await _mintPage.waitForTimeout(2000);

  const hasGrecaptcha = await _mintPage.evaluate(`
    !!(window.grecaptcha && (window.grecaptcha.enterprise || window.grecaptcha.execute))
  `);

  if (!hasGrecaptcha) {
    const sitekey = (cfg.recaptcha_sitekey as string) || RECAPTCHA_SITEKEY;
    debug("Injecting reCAPTCHA scripts...");
    await _mintPage.evaluate((key: string) => {
      if ((window as any).__LM_RECAPTCHA_INJECTED) return;
      (window as any).__LM_RECAPTCHA_INJECTED = true;
      const h = document.head;
      if (!h) return;
      for (const src of [
        "https://www.google.com/recaptcha/enterprise.js?render=" + encodeURIComponent(key),
        "https://www.google.com/recaptcha/api.js?render=" + encodeURIComponent(key),
      ]) {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.defer = true;
        h.appendChild(s);
      }
    }, sitekey);
    await _mintPage.waitForTimeout(5000);
  }

  return _mintPage;
}

export async function mintRecaptchaToken(): Promise<string | null> {
  if (isRecaptchaValid()) return RECAPTCHA_TOKEN;

  clearRecaptchaToken();
  debug("Minting reCAPTCHA v3 token...");

  const cfg = getConfig();
  const sitekey = (cfg.recaptcha_sitekey as string) || RECAPTCHA_SITEKEY;
  const action = (cfg.recaptcha_action as string) || RECAPTCHA_ACTION;

  try {
    const page = await getMintPage();

    const token = (await page.evaluate(`
      (async function() {
        var w = window;
        var g = (w.grecaptcha && w.grecaptcha.enterprise) || w.grecaptcha;
        if (!g || !g.execute) return null;
        try {
          await Promise.race([
            new Promise(function(r) { try { g.ready(r); } catch(e) { r(); } }),
            new Promise(function(r) { setTimeout(r, 5000); })
          ]);
          var p = new w.Object();
          p.action = "${action}";
          return await g.execute("${sitekey}", p);
        } catch(e) { return null; }
      })()
    `)) as string | null;

    if (token) {
      setRecaptchaToken(token, action, RECAPTCHA_TOKEN_TTL_MS);
      debug(`reCAPTCHA token minted (${token.length} chars)`);
      return token;
    }

    // Page might be stale — destroy and recreate on next call
    debug("reCAPTCHA returned null, resetting mint page...");
    try { await _mintPage?.close(); } catch {}
    _mintPage = null;
    return null;
  } catch (e) {
    error("reCAPTCHA minting failed:", e);
    try { await _mintPage?.close(); } catch {}
    _mintPage = null;
    return null;
  }
}

// ---------- Initial data fetch (startup) ----------

export async function fetchInitialData(): Promise<void> {
  debug("Fetching initial data from arena.ai...");
  try {
    const context = await getContext();
    const page = await context.newPage();

    const cfg = getConfig();
    if (cfg.cf_clearance) {
      await context.addCookies([{
        name: "cf_clearance",
        value: cfg.cf_clearance,
        domain: ".arena.ai",
        path: "/",
      }]);
    }

    await page.goto(ARENA_BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: STARTUP_NAV_TIMEOUT_MS,
    });

    await resolveTurnstile(page);

    const cookies = await context.cookies("https://arena.ai");
    const cfClearance = cookies.find((c) => c.name === "cf_clearance");
    if (cfClearance?.value) {
      cfg.cf_clearance = cfClearance.value;
      debug(`Saved cf_clearance: ${cfClearance.value.slice(0, 20)}...`);
    }

    const pageBody = await page.content();
    const modelsMatch = pageBody.match(/\{\\\"initialModels\\\":(\[.*?\]),\\\"initialModel[A-Z]Id/);
    if (modelsMatch) {
      try {
        const unescaped = modelsMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const models = JSON.parse(unescaped);
        if (Array.isArray(models) && models.length > 0) {
          cfg.models = models;
          debug(`Extracted ${models.length} models from page HTML`);
        }
      } catch (e) {
        debug("Failed to parse models from page HTML:", e);
      }
    }

    saveConfig(cfg);
    await page.close();
    debug("Initial data fetch complete");
  } catch (e) {
    error("Initial data fetch failed:", e);
  }
}


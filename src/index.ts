/**
 * LMArena Bridge — main entry point.
 *
 * Fastify server exposing OpenAI + Anthropic compatible API backed by LMArena.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { writeFileSync, existsSync } from "node:fs";

import { PORT } from "./constants.js";
import { healthRoutes } from "./routes/health.js";
import { modelRoutes } from "./routes/models.js";
import { chatRoutes } from "./routes/chat.js";
import { messageRoutes } from "./routes/messages.js";
import { fetchInitialData, closeBrowser } from "./services/browser.js";
import { ensureValidToken } from "./services/auth.js";
import { getConfig, CONFIG_FILE } from "./config.js";
import { debug, error } from "./utils/logger.js";

// ---------- Ensure config.json exists ----------

function ensureConfig(): void {
  if (!existsSync(CONFIG_FILE)) {
    const template = {
      auth_tokens: [],
      api_keys: [
        {
          name: "default",
          key: "lm-" + Math.random().toString(36).slice(2, 10),
          rpm: 60,
          created: new Date().toISOString(),
        },
      ],
      models: [],
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(template, null, 2), "utf-8");
    debug("Created default config.json");
  }
}

// ---------- Main ----------

async function main() {
  ensureConfig();

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // Register routes
  await app.register(healthRoutes);
  await app.register(modelRoutes);
  await app.register(chatRoutes);
  await app.register(messageRoutes);

  // Startup: fetch initial data (models, cf_clearance) unless testing
  if (!process.env.PYTEST_CURRENT_TEST && !process.env.LM_BRIDGE_SKIP_STARTUP) {
    try {
      await fetchInitialData();
    } catch (e) {
      error("Startup data fetch failed:", e);
    }
    // Try to refresh expired tokens
    try {
      const validToken = await ensureValidToken();
      if (validToken) debug("Auth token ready");
    } catch (e) {
      error("Token refresh failed:", e);
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    debug("Shutting down...");
    await closeBrowser();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start server
  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log("=".repeat(60));
  console.log("LMArena Bridge Server Started (TypeScript)");
  console.log(`  API Base:  http://localhost:${PORT}/api/v1`);
  console.log(`  Health:    http://localhost:${PORT}/api/v1/health`);
  console.log(`  Models:    http://localhost:${PORT}/api/v1/models`);
  console.log(`  Chat:      POST http://localhost:${PORT}/api/v1/chat/completions`);
  console.log(`  Messages:  POST http://localhost:${PORT}/api/v1/messages`);
  console.log("=".repeat(60));
}

main().catch((e) => {
  error("Fatal:", e);
  process.exit(1);
});

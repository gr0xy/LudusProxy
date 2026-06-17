import type { FastifyInstance } from "fastify";
import { getConfig } from "../config.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/api/v1/health", async () => {
    const cfg = getConfig();
    const modelsLoaded = Array.isArray(cfg.models) && cfg.models.length > 0;
    const hasTokens = (cfg.auth_tokens?.length ?? 0) > 0 || !!cfg.auth_token;
    const hasCf = !!cfg.cf_clearance;

    return {
      status: hasCf && modelsLoaded ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      checks: {
        cf_clearance: hasCf,
        models_loaded: modelsLoaded,
        model_count: cfg.models?.length ?? 0,
        api_keys_configured: hasTokens,
      },
    };
  });
}

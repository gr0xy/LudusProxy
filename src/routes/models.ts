import type { FastifyInstance } from "fastify";
import { getConfig } from "../config.js";

export async function modelRoutes(app: FastifyInstance) {
  app.get("/api/v1/models", async () => {
    const cfg = getConfig();
    const models = (cfg.models ?? []).map((m: any) => ({
      id: m.publicName ?? m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: m.organization ?? "lmarena",
    }));
    return { object: "list", data: models };
  });
}

/**
 * POST /api/v1/chat/completions — OpenAI-compatible chat endpoint.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { ensureValidToken } from "../services/auth.js";
import { buildCreatePayload } from "../services/lmarena.js";
import { directRequestWithRetry } from "../services/arena-request.js";
import { error } from "../utils/logger.js";

interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
}

export async function chatRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/chat/completions",
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = req.body as ChatRequest;
        const cfg = getConfig();

        // Find model ID
        const modelEntry = (cfg.models ?? []).find(
          (m: any) => m.publicName === body.model || m.id === body.model,
        );
        if (!modelEntry) {
          return reply.code(404).send({
            error: {
              message: `Model '${body.model}' not found. Use /api/v1/models to see available models.`,
              type: "invalid_request_error",
              code: "model_not_found",
            },
          });
        }
        const modelId = (modelEntry as any).id;

        // Get last user message
        const lastUserMsg = [...body.messages]
          .reverse()
          .find((m) => m.role === "user");
        if (!lastUserMsg) {
          return reply.code(400).send({
            error: {
              message: "No user message found",
              type: "invalid_request_error",
            },
          });
        }

        const token = await ensureValidToken();

        // Build LMArena payload (reCAPTCHA token filled by directRequestWithRetry)
        const { payload, url, method } = buildCreatePayload(
          modelId,
          lastUserMsg.content,
          "", // empty — directRequestWithRetry will mint
        );

        // Direct HTTP with retry + reCAPTCHA refresh
        const result = await directRequestWithRetry(url, method, payload, token, cfg);

        if (result.status === 401) {
          return reply.code(401).send({
            error: { message: "Auth token expired or invalid", type: "authentication_error" },
          });
        }

        if (result.status >= 400) {
          return reply.code(result.status).send({
            error: {
              message: result.parsed.error || `LMArena returned ${result.status}`,
              type: "upstream_error",
            },
          });
        }

        return reply.send({
          id: `chatcmpl-${randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.parsed.text },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: result.parsed.text.split(/\s+/).length,
            total_tokens: 0,
          },
        });
      } catch (e) {
        error("chat/completions error:", e);
        return reply.code(500).send({
          error: { message: "Internal server error", type: "server_error" },
        });
      }
    },
  );
}

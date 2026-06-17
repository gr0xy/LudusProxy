/**
 * POST /api/v1/messages — Anthropic Messages API compatible endpoint.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { ensureValidToken } from "../services/auth.js";
import { buildCreatePayload } from "../services/lmarena.js";
import { directRequestWithRetry } from "../services/arena-request.js";
import { error } from "../utils/logger.js";

interface AnthropicRequest {
  model: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  max_tokens: number;
  system?: string;
  temperature?: number;
  stream?: boolean;
}

function flattenContent(
  content: string | Array<{ type: string; text?: string }>
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

export async function messageRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/messages",
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = req.body as AnthropicRequest;
        const cfg = getConfig();

        // Find model
        const modelEntry = (cfg.models ?? []).find(
          (m: any) => m.publicName === body.model || m.id === body.model,
        );
        if (!modelEntry) {
          return reply.code(404).send({
            type: "error",
            error: { type: "invalid_request_error", message: `Model '${body.model}' not found. Use /api/v1/models to see available models.` },
          });
        }
        const modelId = (modelEntry as any).id;

        // Flatten messages
        const parts: string[] = [];
        if (body.system) parts.push(body.system);
        for (const msg of body.messages) {
          parts.push(flattenContent(msg.content));
        }
        const prompt = parts.join("\n\n");

        const token = await ensureValidToken();

        // Build LMArena payload (reCAPTCHA token filled by directRequestWithRetry)
        const { payload, url, method } = buildCreatePayload(modelId, prompt, "");

        const messageId = `msg_${randomUUID()}`;

        // Streaming
        if (body.stream) {
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const sendEvent = (event: string, data: object) => {
            reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };

          sendEvent("message_start", {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              content: [],
              model: body.model,
              stop_reason: null,
              usage: { input_tokens: prompt.length, output_tokens: 0 },
            },
          });

          sendEvent("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });

          // Direct HTTP with retry
          const result = await directRequestWithRetry(url, method, payload, token, cfg);

          if (result.status !== 200 || result.parsed.error) {
            sendEvent("error", {
              type: "error",
              error: {
                type: "upstream_error",
                message: result.parsed.error || `HTTP ${result.status}`,
              },
            });
            reply.raw.end();
            return;
          }

          const responseText = result.parsed.text;

          sendEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: responseText },
          });

          sendEvent("content_block_stop", {
            type: "content_block_stop",
            index: 0,
          });

          sendEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: responseText.split(/\s+/).length },
          });

          sendEvent("message_stop", { type: "message_stop" });
          reply.raw.end();
          return;
        }

        // Non-streaming: direct HTTP with retry
        const result = await directRequestWithRetry(url, method, payload, token, cfg);

        if (result.status === 401) {
          return reply.code(401).send({
            type: "error",
            error: { type: "authentication_error", message: "Auth token expired or invalid" },
          });
        }

        if (result.status >= 400) {
          return reply.code(result.status).send({
            type: "error",
            error: {
              type: "upstream_error",
              message: result.parsed.error || `HTTP ${result.status}`,
            },
          });
        }

        return reply.send({
          id: messageId,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: result.parsed.text }],
          model: body.model,
          stop_reason: "end_turn",
          usage: {
            input_tokens: prompt.length,
            output_tokens: result.parsed.text.split(/\s+/).length,
          },
        });
      } catch (e) {
        error("messages error:", e);
        return reply.code(500).send({
          type: "error",
          error: { type: "server_error", message: "Internal server error" },
        });
      }
    }
  );
}

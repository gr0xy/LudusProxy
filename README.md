# LudusProxy

A bridge server that exposes **OpenAI-compatible** and **Anthropic-compatible** API endpoints backed by [LMArena](https://arena.ai).

## Architecture

```
Client → Fastify Server → LMArena API
                  ↓
          Firefox (headless)
          └─ reCAPTCHA minting only
```

- **All LMArena requests** go via Node.js `fetch` (direct HTTP)
- **Firefox** (Playwright headless) is used **only** to mint reCAPTCHA tokens
- **Retry logic**: automatic reCAPTCHA refresh on 403, backoff on 429

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Health check |
| GET | `/api/v1/models` | List available models |
| POST | `/api/v1/chat/completions` | OpenAI-compatible chat |
| POST | `/api/v1/messages` | Anthropic-compatible messages (with SSE streaming) |

## Setup

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install firefox

# Start the server
npm run dev
```

## Configuration

The server reads `config.json` from the project root. Example structure:

```json
{
  "auth_tokens": ["base64-..."],
  "api_keys": [
    { "name": "default", "key": "lm-...", "rpm": 60, "created": "2026-01-01T00:00:00Z" }
  ],
  "cf_clearance": "...",
  "models": []
}
```

| Field | Description |
|-------|-------------|
| `auth_tokens` | LMArena auth tokens (base64-encoded Supabase sessions) |
| `api_keys` | API keys for client authentication |
| `cf_clearance` | Cloudflare clearance cookie (auto-refreshed at startup) |
| `models` | Model list (auto-discovered at startup from arena.ai) |

## Usage

### OpenAI-compatible

```bash
curl -X POST http://localhost:8000/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Anthropic-compatible

```bash
curl -X POST http://localhost:8000/api/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'
```

### Streaming (Anthropic SSE)

```bash
curl -X POST http://localhost:8000/api/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100,
    "stream": true
  }'
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LM_BRIDGE_SKIP_STARTUP` | Skip browser startup (initial data fetch, token refresh) |
| `LM_BRIDGE_QUIET` | Suppress debug logs |

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Server**: Fastify 5
- **Browser**: Playwright Firefox (headless, reCAPTCHA minting only)
- **Upstream**: LMArena API (arena.ai)

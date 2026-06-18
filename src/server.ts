import { createAnthropicAdapter } from "./adapters/anthropic";
import { createOpenAIChatAdapter } from "./adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "./adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import { loadConfig } from "./config";
import { parseRequest } from "./responses/parser";
import { routeModel } from "./router";
import type { OcxConfig, OcxProviderConfig } from "./types";

const VERSION = "0.0.1";

function resolveAdapter(providerConfig: OcxProviderConfig) {
  switch (providerConfig.adapter) {
    case "openai-chat":
      return createOpenAIChatAdapter(providerConfig);
    case "anthropic":
      return createAnthropicAdapter(providerConfig);
    case "openai-responses":
      return createResponsesPassthroughAdapter(providerConfig);
    default:
      throw new Error(`Unknown adapter: ${providerConfig.adapter}`);
  }
}

async function handleResponses(req: Request, config: OcxConfig): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
  }

  let parsed;
  try {
    parsed = parseRequest(body);
  } catch (err) {
    return formatErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  let route;
  try {
    route = routeModel(config, parsed.modelId);
  } catch (err) {
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  const adapter = resolveAdapter(route.provider);

  if ("passthrough" in adapter && adapter.passthrough) {
    const request = adapter.buildRequest(parsed);
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    } catch (err) {
      return formatErrorResponse(502, "upstream_error", `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });
  }

  const request = adapter.buildRequest(parsed);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
  } catch (err) {
    return formatErrorResponse(502, "upstream_error", `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text().catch(() => "unknown error");
    return formatErrorResponse(upstreamResponse.status, "upstream_error", `Provider error ${upstreamResponse.status}: ${errorText.slice(0, 500)}`);
  }

  if (parsed.stream) {
    const eventStream = adapter.parseStream(upstreamResponse);
    const sseStream = bridgeToResponsesSSE(eventStream, parsed.modelId);
    return new Response(sseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  if (adapter.parseResponse) {
    const events = await adapter.parseResponse(upstreamResponse);
    const json = buildResponseJSON(events, parsed.modelId);
    return new Response(JSON.stringify(json), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return formatErrorResponse(500, "internal_error", "Non-streaming not supported by this adapter");
}

export function startServer(port?: number) {
  const config = loadConfig();
  const listenPort = port ?? config.port ?? 10100;

  const server = Bun.serve({
    port: listenPort,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz" && req.method === "GET") {
        return new Response(JSON.stringify({ status: "ok", version: VERSION }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/v1/responses" && req.method === "POST") {
        return handleResponses(req, config);
      }

      return formatErrorResponse(404, "not_found", `Unknown endpoint: ${req.method} ${url.pathname}`);
    },
  });

  console.log(`🚀 opencodex proxy running on http://localhost:${listenPort}`);
  console.log(`   POST /v1/responses → provider translation`);
  console.log(`   GET  /healthz      → health check`);

  return server;
}

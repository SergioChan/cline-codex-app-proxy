import type { ProviderAdapter } from "./base";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";

export function createResponsesPassthroughAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  return {
    name: "openai-responses",
    passthrough: true as const,

    buildRequest(parsed: OcxParsedRequest) {
      const url = `${provider.baseUrl}/v1/responses`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
      if (provider.headers) Object.assign(headers, provider.headers);

      return {
        url,
        method: "POST",
        headers,
        body: JSON.stringify(parsed._rawBody),
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "passthrough adapter should not parse stream" };
    },
  };
}

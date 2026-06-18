import type { ProviderAdapter } from "./base";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { createResponsesPassthroughAdapter } from "./openai-responses";

export function createAzureAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  const inner = createResponsesPassthroughAdapter({
    ...provider,
    baseUrl: provider.baseUrl,
  });

  return {
    ...inner,
    name: "azure-openai",

    buildRequest(parsed: OcxParsedRequest) {
      const request = inner.buildRequest(parsed);
      const headers = { ...request.headers };
      if (provider.apiKey) {
        headers["api-key"] = provider.apiKey;
        delete headers["Authorization"];
      }
      const apiVersion = (provider.headers?.["api-version"]) ?? "2025-04-01-preview";
      const separator = request.url.includes("?") ? "&" : "?";
      return {
        ...request,
        url: `${request.url}${separator}api-version=${apiVersion}`,
        headers,
      };
    },
  };
}
